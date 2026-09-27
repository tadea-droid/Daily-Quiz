"""
Daily randomised quiz generator.

Reads all PDFs in /pdfs, filters out passages that are only relevant to
states other than NSW, uploads the full filtered passage pool to the
grading worker (so it can generate extra questions on demand), then
generates today's batch of questions and pushes it to the worker.
Finally sends a push notification via ntfy.sh with a link to the answer page.
"""

import json
import os
import random
import re
from datetime import date
from pathlib import Path

import pdfplumber
import requests
from anthropic import Anthropic

PDF_DIR = Path("pdfs")
MIN_CHUNK_CHARS = 300
MAX_CHUNK_CHARS = 1200
QUESTIONS_PER_DAY = 10

OTHER_STATES = [
    "Queensland",
    "Victoria",
    "Tasmania",
    "South Australia",
    "Western Australia",
    "Northern Territory",
    "Australian Capital Territory",
]
NSW_MARKERS = ["New South Wales", "NSW"]


def extract_chunks():
    chunks = []
    for pdf_path in PDF_DIR.glob("*.pdf"):
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                text = (page.extract_text() or "").strip()
                if not text:
                    continue
                sentences = re.split(r"(?<=[.!?])\s+", text)
                current = ""
                for sentence in sentences:
                    candidate = f"{current} {sentence}".strip() if current else sentence
                    if len(candidate) <= MAX_CHUNK_CHARS:
                        current = candidate
                    else:
                        if len(current) >= MIN_CHUNK_CHARS:
                            chunks.append(
                                {"source": f"{pdf_path.name} p.{page_num}", "text": current}
                            )
                        current = sentence
                if len(current) >= MIN_CHUNK_CHARS:
                    chunks.append(
                        {"source": f"{pdf_path.name} p.{page_num}", "text": current}
                    )
    return chunks


def is_nsw_relevant(text):
    mentions_other = any(state in text for state in OTHER_STATES)
    mentions_nsw = any(marker in text for marker in NSW_MARKERS)
    # Skip only passages that name another state and never mention NSW.
    return not (mentions_other and not mentions_nsw)


def build_prompt(chunk):
    return f"""You are writing a quiz question for a mechanical building services
engineer in New South Wales, Australia, studying the National Construction
Code (NCC) 2022 to progress from intermediate to senior level.

Passage (from {chunk['source']}):
\"\"\"
{chunk['text']}
\"\"\"

Write one quiz question based on this passage, following these rules:
- Test understanding of the underlying principle or requirement, not
  memorisation of clause numbers or exact wording.
- If the passage states a specific parameter that matters in practice (an
  airflow rate, temperature, pressure, clearance, rating, or similar figure),
  you may ask about that value, since figures like these matter for
  compliance.
- Focus on what applies in New South Wales. If the passage is only about a
  variation specific to another state or territory, pick a different angle
  from the passage that applies nationally or to NSW instead.
- Keep the question to one or two sentences.

Reply with only JSON, no other text, in this exact shape:
{{"question": "...", "answer": "..."}}"""


def generate_question(client, chunk):
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        messages=[{"role": "user", "content": build_prompt(chunk)}],
    )
    text = response.content[0].text.strip()
    text = re.sub(r"^```json|```$", "", text).strip()
    return json.loads(text)


def push_chunk_pool(chunks):
    worker_url = os.environ["WORKER_URL"].rstrip("/")
    secret = os.environ["SET_SECRET"]
    response = requests.post(
        f"{worker_url}/chunks",
        json={"chunks": chunks},
        headers={"Authorization": f"Bearer {secret}"},
        timeout=30,
    )
    response.raise_for_status()


def push_today(questions):
    worker_url = os.environ["WORKER_URL"].rstrip("/")
    secret = os.environ["SET_SECRET"]
    payload = {"date": date.today().isoformat(), "questions": questions}
    response = requests.post(
        f"{worker_url}/set",
        json=payload,
        headers={"Authorization": f"Bearer {secret}"},
        timeout=15,
    )
    response.raise_for_status()


def send_notification(message):
    topic = os.environ["NTFY_TOPIC"]
    requests.post(
        f"https://ntfy.sh/{topic}",
        data=message.encode("utf-8"),
        headers={"Title": "Daily Quiz", "Tags": "brain"},
        timeout=15,
    )


def main():
    all_chunks = extract_chunks()
    chunks = [c for c in all_chunks if is_nsw_relevant(c["text"])]

    if not chunks:
        send_notification("No quiz today: no usable text found in pdfs/.")
        return

    push_chunk_pool(chunks)

    sample_size = min(QUESTIONS_PER_DAY, len(chunks))
    chosen_indices = random.sample(range(len(chunks)), sample_size)

    client = Anthropic()
    questions = []
    for qid, chunk_index in enumerate(chosen_indices):
        chunk = chunks[chunk_index]
        qa = generate_question(client, chunk)
        questions.append(
            {
                "id": qid,
                "chunkId": chunk_index,
                "question": qa["question"],
                "answer": qa["answer"],
                "source": chunk["source"],
            }
        )

    push_today(questions)

    page_url = os.environ.get("PAGE_URL", "")
    message = f"Today's quiz is ready: {len(questions)} questions."
    if page_url:
        message += f"\n{page_url}"
    send_notification(message)


if __name__ == "__main__":
    main()
