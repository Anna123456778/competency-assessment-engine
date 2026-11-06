# Competency Assessment Engine (demo)

A browser-based assessment engine I designed for school-wide competency testing at a K-9 school in Ukraine: 198 learners, about 20 test authors, shared laptops, no budget for a developer, and air-raid alerts in Ukraine that can stop a test session at any moment.

This repository is a public English demo copy with a neutral brand and one sample test. The live system runs in Ukrainian on separate infrastructure.

## For recruiters and hiring managers

You do not need to read code to evaluate this project. Three things are worth your time:

1. Take the demo test. It takes about 20 minutes and shows the learner experience end to end, including the results screen.
2. Read the case study. It explains the design decisions, the review process and the results of the first school-wide run.
3. Open `public/demo-data.js`. It holds every question of the demo test and no answers. That is the core design decision of the system, explained below.

[Try the demo](https://anna123456778.github.io/competency-assessment-engine/public/demo.html) · [Read the case study: From Ad-Hoc Tests to Trusted Learning Data](https://buttercup-objective-cfb.notion.site/From-Ad-Hoc-Tests-to-Trusted-Learning-Data-40ec63a2e16b815fbca0ea315d74a5a7)

Guest code: `246810`. If the attempt locks after repeated exits from the page, the unlock code is `517362`.

## The demo test

"Using generative AI responsibly at work": a 10-question scenario assessment built around one character, Maya Collins, a civil servant who uses AI tools in her daily work. It measures 5 skills for 20 points in total. Each wrong answer is written to reveal a specific misconception, not just to be wrong.

## What the system does

- Runs any test from a single engine. Each test is a small data block, so a new test never touches the engine code.
- Shows the learner a level, the number of correct answers, the questions they missed and a table of results by skill, written in the first person ("I can...").
- Saves every answer as its own record, so each attempt can be traced and each question analysed.
- Sends teachers an automatic report on the day of the test. Teachers get the report, not access to the data, so results cannot be changed afterwards.
- Pauses for air-raid alerts. The attempt waits and resumes only with the group code, so an alert never costs a learner their attempt.
- Logs every exit from the test page with its type, time and duration. Every fifth exit locks the attempt until the person running the session enters an unlock code. The system records what happened; the decision to annul stays with a person.

## Architecture

![Architecture](docs/architecture.png)

| Part | Runs on | Responsibility |
| --- | --- | --- |
| Engine | Browser, hosted on Cloudflare | Renders questions, collects answers, handles pause, fullscreen and exits |
| Test data block | Browser | Questions, options, skills and points. No answer key |
| Receiver | Google Apps Script | Checks the group code, scores the attempt, writes records, builds reports |
| Data store | Google Sheets | Test register, answer keys, raw answers, attempts, exits |

## Why the answer key is not in this repository

The answer key and the scoring live only on the server. A key inside the page code can be read by any learner who opens the developer tools.

This is why the code can be public. Read every line of the engine and the demo test: you will find the questions, but not the answers.

## Adding a new test

A new test is a data block, not new code. Building one takes about 30 minutes.

1. Write the test against expected learning outcomes. Every question links to an outcome, and every outcome is checked by at least one question.
2. Add the data block (questions, options, skill for each question, points) as a separate file, following `public/demo-data.js`.
3. Add the answer key to the sheet on the server, never to the repository.
4. Register the test as inactive, with no time window.
5. Run a trial attempt in admin-only mode, where the report goes only to the admin. Compare every key with the author's original.
6. Open the time window.

## How it was built with AI

I designed the system and built it with Claude as a coding partner. I made every product and teaching decision: levels instead of points, skills instead of topics, the integrity rules, how the air-raid pause works, what happens when a learner leaves the page, and the tone of every text a learner sees. Claude wrote code from the logic I described, turned teachers' tests into data blocks, checked answer keys for defects and ran the calculations.

These are the rules the AI had to follow:

- the answer key and scoring live only on the server;
- the engine is never rewritten for a test, each test gets only a data block;
- edits are targeted, never a full file regenerated;
- if a key is missing or unclear, ask, never guess;
- errors in a teacher's test are never fixed silently;
- no deploys on a test day;
- no access to the repository, so every file reaches production only through my manual upload.

The last rule applies here too: every file in this repository was uploaded by hand.

In 10 days the engine went through about 7 versions and the receiver through about 6. The first school-wide run had 52 group sessions, 513 completed attempts and zero system failures.

## Repository structure

```
public/
  demo.html        entry page of the demo
  engine.js        the test engine
  engine.css       styles
  demo-data.js     data block of the demo test (no answer key)
  q3_evidence.png  image used in question 3
apps-script/
  Code.gs          Google Apps Script receiver
docs/
  architecture.png architecture diagram
```

## Author

Anna Dobrovolska, Learning Experience Designer

[Portfolio](https://bit.ly/anna-dobrovolska) · [LinkedIn](https://www.linkedin.com/in/anna-dobrovolska-08651a204)
