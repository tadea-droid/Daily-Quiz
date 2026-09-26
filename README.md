# Daily Quiz

Sends you one randomised quiz question every weekday morning, generated from
PDFs in this repo, with a page where you can type your answer and get graded.

## How it fits together

1. A GitHub Action runs on weekday mornings. It reads your PDFs, picks a
   random passage, and asks Claude to write one question and answer.
2. It sends that question and answer to a small Cloudflare Worker, which
   stores it.
3. It pushes a notification to your phone via ntfy.sh, with a link to your
   answer page.
4. The answer page (hosted free on GitHub Pages) fetches the question from
   the Worker, and when you submit your answer, the Worker asks Claude to
   grade it and returns correct or incorrect.

The correct answer only ever lives in the Worker, not in the page's source,
so opening the page doesn't give the answer away.

## Setup

### 1. GitHub repo

- Create a new GitHub repo and push these files.
- Drop your PDFs into `pdfs/` and commit them.

### 2. Cloudflare Worker

You'll need a free Cloudflare account and the `wrangler` CLI (`npm install -g
wrangler`).

```
cd worker
wrangler login
wrangler kv namespace create QUIZ_KV
```

Copy the namespace `id` this prints into `worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Set the two secrets the Worker needs:

```
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SET_SECRET
```

`SET_SECRET` is a password you make up. It stops anyone but your GitHub
Action from overwriting today's question. Use a long random string.

Deploy it:

```
wrangler deploy
```

This prints your Worker's URL, something like
`https://daily-quiz-worker.yourname.workers.dev`. Keep it.

### 3. Answer page

Open `docs/index.html` and replace `REPLACE_WITH_YOUR_WORKER_URL` with the
URL from the previous step. Commit the change.

In the repo, go to Settings > Pages, and set the source to the `main` branch,
`/docs` folder. GitHub gives you a URL like
`https://yourname.github.io/daily-quiz/`. Keep it too.

### 4. ntfy

Pick a private topic name, e.g. `taira-quiz-8f3k2`, and treat it like a
password since anyone who knows it can read your notifications. Install the
ntfy app and subscribe to that topic.

### 5. GitHub secrets

In the repo, go to Settings > Secrets and variables > Actions, and add:

- `ANTHROPIC_API_KEY`: your Anthropic API key
- `NTFY_TOPIC`: your ntfy topic name from step 4
- `WORKER_URL`: your Worker's URL from step 2
- `SET_SECRET`: the same value you set with `wrangler secret put SET_SECRET`
- `PAGE_URL`: your GitHub Pages URL from step 3

### 6. Test it

Go to the Actions tab, select "Daily Quiz", and run it manually. You should
get a push notification within a minute, and the linked page should show the
question and grade your answer.

## Notes

- Sydney's UTC offset changes with daylight saving, so the notification
  time drifts by about an hour around the changeover dates in April and
  October. Adjust the cron line in the workflow file if you want to correct
  for this.
- Repeats are possible since each morning picks independently at random. If
  you want it to work through the material without repeating, say so and
  the script can track asked chunks and exclude them.
- The Worker only keeps today's question. If you want a history you can look
  back on, that's a small addition to the Worker.
