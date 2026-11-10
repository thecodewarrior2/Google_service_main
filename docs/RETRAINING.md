# Retraining the AI model with your own examples

Marking an email **False alarm** or **Confirm phishing** doesn't teach the AI model anything by itself.
The model (phish-tiny) is a fixed file that comes with each version. It learns only when it is trained
again, in the S.P.R.U.C.E+ extension's repository, and the new model comes to the service with a new
version.

This guide turns the emails your admins marked into training examples, and the examples into a better
model, without any person's details reaching a repository or an outside service.

**In short:**

1. **Allow and download.** An admin downloads the marked emails from Status → Model health. They arrive with
   the people already taken out.
2. **Review.** A person reads every example and decides on each word marked ⟦like this⟧.
3. **Replace the placeholders.** [NAME] and the others become made-up names, by hand or with claude.ai
   (only if your district allows it, and only after the review).
4. **Final check.** `tools/check-training-file.js --final` refuses the file until nothing is left.
5. **Split and measure.** A third of the examples are kept aside, and the current model is scored on
   them.
6. **Train.** In the extension's repository, from the other two thirds.
7. **Compare.** The new model must do better on the examples kept aside. If it doesn't, it isn't
   used.
8. **Release and clean up.** The new model comes with a new version that the maintainer approves.
   Then the files are deleted and the export is turned off.

## Before you start

- **Ask whether you may.** Even with the names taken out, these are your staff's and families' emails.
  Your district decides, under its data agreements and FERPA, who may prepare training examples and
  whether de-identified email text may go to an outside AI service such as claude.ai. If it may not, do
  step 3 by hand.
- **Two people are better than one.** One prepares the file, the other reads it before it goes anywhere.
- **What it takes:** a computer or Cloud Shell with Node 20 or later and this version's folder (the zip
  you installed from, or a copy of `google_service_main`). Training also needs Python 3 with `torch` (the
  CPU build is enough) and `transformers`, and the extension's repository (step 6).
- **Only admins' marks count.** The export takes the emails an admin marked: **Confirm phishing**, and
  **Mark false alarm** or an admin's **Release**. A user moving an email out of Spam is not a label: people
  rescue phishing too.

## 1. Allow the export, then download

1. **Settings → Retraining export → Allow the retraining export.** It is off by default. Activity
   notes who turned it on, and every download.
2. **Status → Model health → Examples for retraining the model.** Choose the period at the top (7, 30 or 90
   days).
3. **Include false alarms** if you want genuine examples. They are worth the most, because they teach
   the model what not to flag, but they are real people's mail: check them with the most care (step 2).
4. **Download for retraining.** It takes up to a minute. Under the button you see how many examples the
   file has, how many were no longer in a mailbox, and how many campaigns were left out because they
   were marked both ways.

What is in the file:
- One example per campaign: the newest copy still in a mailbox. Copies of one email would count it many
  times.
- At most 100, newest first. For older ones, choose a shorter period and download again.
- Each email is read from Gmail at the moment you download and judged again as on arrival, to get what
  the model read. Nothing of it is stored by the service: the file is the only copy.

**Keep the file on your computer only.** Don't put it in a shared drive or email it. Delete it when you
are done (step 8).

## How to read the file

The file is JSON Lines: one example per line, in the extension's own training format (the format of
`tools/ai/data/extra/*.jsonl`). A text editor that doesn't wrap lines shows one email per line. Here is
one line, spread out (from the demo's made-up data):

```json
{
  "name": "spruce-18c2f3a9b0d1e2f4",
  "label": 1,
  "note": "Confirmed as phishing or spam by an admin. On arrival: moved to Spam; trigger rules+ai, rules score 28.5, AI 100%.",
  "facts": {
    "subject": "Your password expires today",
    "senderName": "Microsoft 365 Security",
    "senderAddress": "security@micros0ft-support.example",
    "auth": { "dmarc": "fail" },
    "links": [{ "text": "Keep my password", "host": "micros0ft-support.example", "destHost": "",
                "finding": "look-alike domain: micros0ft-support.example imitates microsoft.com" }],
    "bodyText": "Dear User,\n\nYour Microsoft 365 password will expire in 2 hours.\n\nClick the button below to keep your current password.\n\nKeep my password\n\nMicrosoft Security Team",
    "org": "outside"
  }
}
```

| Field | What it is |
|---|---|
| `name` | `spruce-` and the email's Gmail ID. To see the email's record, paste the ID into **Email → Messages → Search**. That page also shows the email's Message-ID, for Google Workspace's Email log search. |
| `label` | `1`: phishing or spam (an admin confirmed it). `0`: genuine (an admin marked it a false alarm). |
| `note` | What the service did on arrival: what it did with the email, what triggered it, the rules score, the AI score. It is for you; training ignores it. |
| `facts.subject`, `senderName`, `bodyText` | What the email said, with the people taken out (below). `bodyText` is cut to about 1,200 characters, a little more than the model reads. |
| `facts.senderAddress` | The sender's domain. The part before @ is kept only for shared mailboxes (`noreply`, `security`, `billing`); otherwise it is `sender`. |
| `facts.auth.dmarc` | Gmail's DMARC check of the sender: `pass`, `fail`, `none`, or missing (unknown). |
| `facts.links` | Up to 8 links: their text, where they point (`host`), where they really go when that differs (`destHost`), and what the checks found (`finding`). |
| `facts.org` | `inside` (from your own domains, DMARC passing) or `outside`. |
| `facts.layout`, `facts.mailChecks` | How the email hides its text, and what mail systems found in its headers, when either applies. |

The model never sees the file as it is. It reads one line built from the facts. For the example above:

```
subject: Your password expires today. from: "Microsoft 365 Security" at micros0ft-support.example (outside your organization) (shared mailbox). sender check: dmarc fail. links: "Keep my password" goes to micros0ft-support.example (warning: look-alike domain: …). text: Dear User, Your Microsoft 365 password will expire in 2 hours. …
```

### What was already taken out

| In the email | In the file |
|---|---|
| The recipient's name and mailbox name, anywhere (also in capitals, and as a sender named after them) | `your name`. This is how the model sees it in use too, so leave it as it is. |
| The other people in To, Cc and Reply-To, and names after Mr., Ms., Dr., after "Hi"/"Dear", and after "Thanks,"/"Regards," | `[NAME]` |
| The sender's name and address, when the email is genuine (a false alarm) or from inside your domains | `[SENDER]`, and `sender@` in the address |
| Your organization's domains (in addresses, links and text) | `[OUR-DOMAIN]` |
| Email addresses | `address at` and the domain |
| Phone numbers, and long numbers (accounts, cards, student IDs, codes) | `phone number`, `number` |
| Text past what the model reads | cut |

An outside phishing sender's name is kept: attackers choose it, and it is part of the trick ("Microsoft
365 Security" from a look-alike domain). Names in it are still taken out or marked.

**Look-alikes of your own domain are kept** (for example `maple-schools-login.example`). They are the
trick the model must learn. They name your district, not a person. In step 3 you can rename them along
with `[OUR-DOMAIN]`, keeping the look-alike shape.

### What is marked ⟦like this⟧

These are words that may be names, and nobody has decided yet:
- capitalized words in the middle of a sentence that aren't everyday words;
- common first names and surnames, and unusual words, at the start of a sentence or in a headline;
- your organization's own name (`⟦Maple⟧` from `maple-schools.example`).

Brands and everyday words are usually not marked, but some are. The check (steps 2 and 4) refuses a
file with a mark left.

## 2. Review every example yourself

Go through the file line by line. For each line:

1. **Every ⟦mark⟧.** If it names a person, a school, a place or anything else that identifies someone,
   replace it with a placeholder: `[NAME]` for a person, `[SCHOOL]`, `[PLACE]`. Use the same placeholder
   for the same thing in one line. Otherwise (a brand, a product, an ordinary word) remove the marks and
   keep the word.
2. **Read all of the text, not only the marks.** The removal can miss things:
   - a name written in lower case, a nickname, or a name in another language;
   - a signature block or a quoted earlier message;
   - a detail that identifies someone without a name: a student's health, IEP, discipline, grades or
     custody, a home address, an event only one family was part of.

   Replace what you can. **Delete the whole line if the email can't be made anonymous.** That happens
   most often with false alarms, and losing one example costs little.
3. **Is the label right?** `1` must be phishing or spam, and `0` must be genuine mail. If you aren't
   sure, delete the line: one wrong label does more harm than one missing example.
4. **Keep the tricks.** Don't change what makes phishing phishing:
   - the link hosts and look-alike domains, and the DMARC result;
   - the urgency, the threats and the rewards;
   - the request for a password, a payment or gift cards;
   - "your name".

   Don't tidy up the spelling mistakes either.
5. **Don't add fields.** In particular, don't add a `text` field: the extension's dataset builder would
   use it instead of the facts.

Then run the check from this version's folder, in Cloud Shell or on your computer. It needs Node 20 or
later and nothing else:

```bash
node tools/check-training-file.js spruce-retraining-2026-11-10.jsonl
```

It lists each problem it finds: a mark left, an address, a phone number or a long number, a field
missing, or the same email twice. It also says how many examples of each kind the file has. Fix the
problems (or delete those lines) until it says **No leftovers found**. The check can't see a name it
doesn't know, so it doesn't replace your reading.

## 3. Replace the placeholders with made-up names

`[NAME]`, `[SENDER]`, `[OUR-DOMAIN]`, `[SCHOOL]` and `[PLACE]` don't look like real mail. The model should
learn from text that does, so replace each one with something made up:
- **People:** made-up names. Use the same one for the same placeholder within an email. Different emails
  can reuse names.
- **`[OUR-DOMAIN]`:** one made-up district domain, used in every line, shaped like the ones the
  extension's generator makes: a word such as `cedar`, `northfield` or `oakridge`, then `schools` or
  `district`, then `.org` or `.us`. If you rename the look-alikes of your domain, keep their shape:
  `maple-schools-login.example` → `cedar-schools-login.example`.
- **`[SENDER]`:** a made-up name of the same kind, a person's or a company's.

**By hand** is always fine. **With claude.ai**, only if your district allows de-identified email text to
go to it, and only once the review is done and the check passes: the file must have nothing personal in
it before it is uploaded. Upload the file, with this request:

> I'm preparing training examples for a small phishing classifier. The attached file is JSON Lines, one
> email per line, already de-identified and reviewed by a person. For every line:
> 1. Replace each placeholder with a made-up one: [NAME] with a made-up person's name, [SENDER] with a
>    made-up sender name of the same kind (a person or a company), [OUR-DOMAIN] with cedar-schools.org,
>    [SCHOOL] with a made-up school, [PLACE] with a made-up place. Within one line, the same placeholder
>    gets the same made-up name.
> 2. Lightly reword "subject" and "bodyText" so they aren't the original wording. Keep the meaning, tone,
>    length, mistakes and tricks (urgency, threats, rewards, requests for passwords, payments or gift
>    cards), and keep "your name" as it is.
> 3. Don't change "name", "label", "note", "senderAddress", "auth", "org", "layout", "mailChecks", or any
>    link's "host", "destHost" or "finding", except for replacing [OUR-DOMAIN].
> 4. If anything still looks personal (a real-looking name, an address, a number, a detail about a
>    student), replace it with something made up, and tell me which lines.
>
> Give me the result as JSON Lines in one code block, the same number of lines in the same order, valid
> JSON, nothing else in the block. After the block, list the lines from step 4.

Save the code block as the new file. Then check what came back:
- the number of lines is the same;
- the labels are unchanged, and so are the tricks;
- read the lines it listed in step 4.

Claude can make mistakes, so read the result too.

**Variants (optional).** One example counts once in training, while each of the extension's published
examples is trained on in 12 variants. To give an important example more weight, you can ask for two
more versions of it, with other made-up names and wording, named like the original plus `-v1` and
`-v2` (`spruce-18c2f3a9b0d1e2f4-v1`). Variants of one email must stay together when the file is split
(step 5), and the split tool keeps them together.

## 4. The final check

```bash
node tools/check-training-file.js --final spruce-retraining-2026-11-10.jsonl
```

With `--final`, a placeholder left over is refused too. Fix the file until it says **Ready for
training**.

**Keep the two kinds balanced.** If the file is nearly all phishing, training tends to make the model
flag more genuine mail. Aim for roughly as many genuine examples as phishing ones: include false alarms,
or leave out some phishing. The check says when one kind is under a quarter of the file.

## 5. Keep a third aside, and score the current model

```bash
node tools/split-examples.js spruce-retraining-2026-11-10.jsonl
```

It writes `…-train.jsonl` and `…-held-out.jsonl`. Every third email of each kind goes to the held-out
file, with its variants. **Never train on the held-out file.** It is how you find out whether the new
model is better on your district's mail, rather than only on what it was taught.

Score the model the service runs now, and write the numbers down:

```bash
node tools/score-examples.js spruce-retraining-2026-11-10-held-out.jsonl
```

It shows the missed phishing and the false alarms at the service's move threshold (0.85, or
`--threshold` to match your `AI_MOVE_THRESHOLD`), and lists the emails it got wrong.

## 6. Train (in the extension's repository)

phish-tiny is trained in the S.P.R.U.C.E+ extension's repository, on its `llm_testing` branch, by
whoever looks after the model there, following that repository's own rules (its `CLAUDE.md`). Its
`tools/ai/README.md` describes the training in full.

The service runs the model it was last synced with (**Settings → Model**). The extension's branch may
already have a newer one, and your examples are added to the newest. To see what your examples add on
their own, sync and score the extension's current model first (step 7's commands), before step 1 below.

With your examples:

1. Copy the train file into the extension's folder as
   `tools/ai/data/extra/spruce-service-2026-11-10.jsonl`. `tools/ai/data/` is never committed (it is in
   `.gitignore`): run `git status` to make sure the file isn't listed.
2. Build the dataset. It reports how many training emails it has, and that number should be higher by
   the number of your examples:

   ```bash
   node tools/ai/make-dataset.js
   ```

3. Train, with a version number higher than the one in `models/phish-tiny/model.json`:

   ```bash
   python3 tools/ai/train.py --version 0.12.0 --seeds 7,8,9 --runs-dir ~/phish-runs
   ```

4. Compare the new `models/phish-tiny/MODEL_CARD.md` with the previous model's card:
   - **genuine look-alikes** and **real-world genuine, held out**: the false alarms;
   - **real-world, held out**: the missed phishing;
   - **hand-written**.

   If the false alarms rose, add more genuine examples or fewer phishing ones, and train again.
5. Run the extension's tests (`cd tests && node run-all.js`). They fail if the model gets the
   hand-written emails or the regression cases wrong.
6. **A false alarm that matters** (one that moved real mail) can also become a regression case:
   - add its made-up version to `tests/fixtures/ai-regressions.jsonl`, in the same format, with a
     `note` that says what it was;
   - every later model must then get it right.

   That file is committed, so it may only hold made-up names, as in the rest of the file.
7. Commit the new model, following the extension's rules: version, changelog, its maintainer's
   approval. The files are `models/phish-tiny/*`, `tests/fixtures/ai-vectors.json` and any regression
   cases. Your examples stay out of the commit.

The extension's model scores use 0.5 as the line between phishing and genuine; the service moves mail
only from `AI_MOVE_THRESHOLD` (0.85 by default). That's why step 7 scores at the service's threshold.

## 7. Is the new model better?

In this repository (`google_service_testing`), with the extension checked out at the new commit:

```bash
node tools/sync-engine.js ../spruce-browser-extension
```

```bash
npm test
```

```bash
node tools/score-examples.js spruce-retraining-2026-11-10-held-out.jsonl
```

Compare with the numbers from step 5:
- **Better:** fewer false alarms and fewer missed phishing at the same threshold, or one lower and the
  other unchanged.
- **Not better:** don't use it (`git checkout vendor/spruce`), and train again with more or better
  examples.

To keep the score honest:
- don't move examples from the held-out file into training to raise it;
- don't change the held-out examples, or the extension's generator, to fit it.

Once a held-out file has been used to choose between several models, its score becomes optimistic. Use
new examples for the next round.

With 30 held-out emails, one email is 3%, so a small set tells you about large changes, not small ones.

## 8. Release it, and clean up

- **Release:** the new model comes to the service like any change:
  - a version bump, with a changelog line ("phish-tiny 0.12.0, trained with 40 of our examples");
  - the tests and a look in demo mode;
  - the maintainer trying that version and approving it.

  Admins then upgrade with `bash deploy/update.sh`, which shows the model's version change.
- **After the upgrade:** watch Status → Model health for a week. If the undo rate for **AI score** moves go up,
  roll back (`bash deploy/rollback.sh`) and look at the emails it moved.
- **Clean up:**
  - delete the downloaded file and the in-between files (and the claude.ai conversation, if you used
    one);
  - keep only the final files, which have no personal data, somewhere private, for the next round;
  - **Settings → Retraining export → off.**

## When training goes wrong, it is usually one of these

- **Wrong labels:** a user's "Not spam" taken as genuine, or spam called genuine. Only admins' marks are
  exported; still check each one (step 2).
- **One email many times:** copies pasted in, or variants split across train and held-out. The export
  gives one per campaign, and the split keeps variants together.
- **Only one kind:** nearly all phishing makes more false alarms (step 4).
- **Placeholders left in:** the model learns "[name]" instead of names. `--final` refuses them.
- **A `text` field:** the dataset builder uses it instead of the facts. The check refuses it.
- **Training on the held-out examples, or fitting the generator to them:** the score stops meaning
  anything.
- **Personal data in a repository:** only `tools/ai/data/extra/`, which is never committed, holds your
  examples. Regression cases and anything else committed are made up.
