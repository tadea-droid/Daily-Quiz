"""
Daily randomised quiz question generator.

Reads all PDFs in /pdfs, picks a random chunk of text, asks Claude to turn it
into one quiz question, stores the question and answer in the grading worker,
and sends a push notification via ntfy.sh with a link to the answer page.
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


def extract_chunks():
    chunks = []
    for pdf_path in PDF_DIR.glob("*.pdf"):
        with pdfplumber.open(pdf_path) as pdf:
            text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        paragraphs = re.split(r"\n\s*\n", text)
        for para in paragraphs:
            para = para.strip()
            if MIN_CHUNK_CHARS <= len(para) <= MAX_CHUNK_CHARS:
                chunks.append({"source": pdf_path.name, "text": para})
    return chunks


def generate_question(chunk):
    client = Anthropic()
    prompt = f"""Here is a passage from {chunk['source']}:

{chunk['text']}

Write one quiz question that tests understanding of this passage, and give
the correct answer. Reply with only JSON, no other text, in this exact
shape: {{"question": "...", "answer": "..."}}"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    text = re.sub(r"^```json|```$", "", text).strip()
    return json.loads(text)


def push_to_worker(chunk, qa):
    worker_url = os.environ["WORKER_URL"].rstrip("/")
    secret = os.environ["SET_SECRET"]
    payload = {
        "date": date.today().isoformat(),
        "question": qa["question"],
        "answer": qa["answer"],
        "source": chunk["source"],
    }
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
    chunks = extract_chunks()
    if not chunks:
        send_notification("No quiz today: no usable text found in pdfs/.")
        return

    chunk = random.choice(chunks)
    qa = generate_question(chunk)
    push_to_worker(chunk, qa)

    page_url = os.environ.get("PAGE_URL", "")
    message = qa["question"]
    if page_url:
        message += f"\n\nAnswer here: {page_url}"
    send_notification(message)


if __name__ == "__main__":
    main()
