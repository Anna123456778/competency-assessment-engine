/* Test data block: the only file written per test. No answer key here: the key lives in the Questions sheet.
   Fields:
     title, bank (question bank ID, matches Questions A), version (written into every response row)
     primary   true for grades 1-4 (levels only, friendlier statuses); false for older students and adults
     levels    level names in ascending order, same as the Levels sheet (used for the badge colour)
     topicsTitle, topicsCol, pointsTitle   optional headings on the result screen
   Fields added for the adult demo (Stage 3):
     intro          start-screen text shown above the rules; \n starts a new paragraph
     keepOrder      true = questions appear in the order below, no shuffle; options are still shuffled
     learnerLabel   word used instead of "Student"
     contactLabel   phrase used instead of "your teacher"
     groupLabel     word used instead of "class" (pause screen: "the group code")
     feedback       one line under each skill status on the result screen:
                    { 'I can ...': { mastered, nearly, review } }, keys match the topic field exactly
   Question fields:
     id     question number as in Questions B
     type   omitted = multiple choice | 'match' | 'number' | 'fill'
     text, img, alt, topic (row of the result-by-skill table, written as "I can ..."), lvl (difficulty level), pts (points, default 1)
     choice:  options [{k, t, img}]           k is the key letter the server compares with Questions E
     match:   left [{k, t}], right [{k, t}], leftTitle, rightTitle
     number:  unit, maxLen
     fill:    items ['3 □ 4 = 12'], choices ['<','>','='] (optional), maxLen */

var S1 = 'I can tell what is safe to share with an AI tool';
var S2 = 'I can spot errors in AI output';
var S3 = "I can decide where a person must check AI's work";
var S4 = 'I can say who is accountable for a decision made with AI';
var S5 = 'I can choose a responsible way to use AI at work';

window.TEST_DATA = {
  title: 'Using generative AI responsibly at work',
  bank: 'AIWORK-DEMO',
  version: 'aiwork-demo-1.0',
  primary: false,
  topicsTitle: 'Result by skill',
  topicsCol: 'Skill',
  levels: ['Beginning', 'Developing', 'Proficient', 'Advanced'],

  intro: 'You are Maya Collins, a policy officer at Harbourline Regional Authority. Today you are preparing a briefing for senior leaders on the public consultation about local bus routes. Your team can use a public generative AI chat tool.\n' +
         'Authority rule: only information that is already published may be entered into a public AI tool.\n' +
         "The questions follow Maya's working day, from 9:00 to 17:30.",
  keepOrder: true,
  learnerLabel: 'Participant',
  contactLabel: 'your facilitator',
  groupLabel: 'group',

  feedback: {
    [S1]: {
      mastered: "The report and the timetable went in; the residents' responses, the draft and the ridership figures stayed out. That is the Authority rule, applied exactly.",
      nearly: 'Look again at the ridership figures and the anonymised responses. Both feel safe, and neither is published.',
      review: "At 9:00 every item needed one question: is it on the Authority's website today? Deleting names, switching off training or \"out next month\" does not change the answer."
    },
    [S2]: {
      mastered: 'You caught the wrong total, the report that does not exist and the quote nobody said, and you kept the line about evening services that Maya had read herself.',
      nearly: "Something from the AI summary got through: the total, the source or the resident's quote. Each looked convincing, and none of them matched Maya's records.",
      review: "The summary gave 1,240 responses, cited a survey the library cannot find and quoted a resident nobody can trace. All three looked real. Maya's records decide what goes into the briefing, however sure the AI sounds."
    },
    [S3]: {
      mastered: 'You let the AI sort the responses and kept the counts, the decision on Route 12 and the reply to residents with people.',
      nearly: 'Look again at the outline Maya rewrites in her own words, or at who does what on Route 12. New wording does not mean anyone checked what the AI put in.',
      review: "The AI sorted 1,124 responses well. It cannot decide whether Route 12 closes, and the counts and the reply to residents go out under someone's name. That person reviews them first."
    },
    [S4]: {
      mastered: 'You named Maya as the first check on the figure, and you saw that a disclaimer would not change that.',
      nearly: 'Tom approved the briefing, but Maya put the figure in. The first check belongs to whoever uses the output.',
      review: "The tool made the mistake; Maya and the Authority answer for it. Neither Tom's approval nor a line saying \"produced by AI\" moves that."
    },
    [S5]: {
      mastered: 'Your 17:30 plan got every step right, including the one people skip most often: saying where AI was used.',
      nearly: "One step went missing. Usually it is the note on AI use, or checking against the AI's own sources instead of Maya's records.",
      review: "The 17:30 plan is the whole day in one line: the published report only, figures checked against Maya's records, AI use noted, the director decides. Each wrong option dropped one of these steps. Deleting the chat or asking the AI to double-check does not replace any of them."
    }
  },

  questions: [
    {
      id: '1',
      type: 'fill',
      topic: S1,
      lvl: 2,
      pts: 2,
      text: '9:00. Maya is gathering material for the summary. Can she enter each item into the public AI tool?',
      items: [
        "The consultation report published on the Authority's website: □",
        'The public timetable for Route 12: □',
        "Residents' responses, exported with names and email addresses: □",
        'Her draft briefing, which has not been cleared yet: □',
        "Last year's ridership figures, due for publication next month: □"
      ],
      choices: ['Can enter', 'Keep out']
    },
    {
      id: '2',
      topic: S1,
      lvl: 2,
      pts: 2,
      text: "A colleague suggests: \"Delete the names and emails from the residents' responses first, then paste them in.\" What should Maya do?",
      options: [
        { k: 'A', t: 'Paste them in. With names and emails removed, the responses are anonymous.' },
        { k: 'B', t: "Paste them in after turning off model training in the tool's settings." },
        { k: 'C', t: 'Keep them out. Free-text answers can still identify people, and the responses are not published.' },
        { k: 'D', t: 'Paste in only the responses that mention no addresses or other personal details.' }
      ]
    },
    {
      id: '3',
      type: 'fill',
      topic: S2,
      lvl: 2,
      pts: 2,
      text: '11:00. The AI tool returns this summary:\n' +
            '"Of 1,240 responses, 68% supported keeping Route 12 (Source: Harbourline Transport Survey 2023, p. 14). Residents raised concerns about evening services."\n' +
            "Maya has read all the residents' comments herself. Check the summary against her records and the library search in the image.",
      img: 'q3_evidence.png',
      alt: 'Two panels. Left, Maya\'s records: 1,124 consultation responses received. Right, Authority library search for "Harbourline Transport Survey 2023": 0 results, no report with this title.',
      items: [
        '"Of 1,240 responses, 68% supported keeping Route 12": □',
        '"Source: Harbourline Transport Survey 2023, p. 14": □',
        '"Residents raised concerns about evening services": □'
      ],
      choices: ['Use as it is', 'Correct or remove']
    },
    {
      id: '4',
      topic: S2,
      lvl: 2,
      pts: 2,
      text: 'The summary quotes a resident: "The 7 pm bus is the only way I get home from my shift." Maya cannot find this quote in the original responses. What should she do?',
      options: [
        { k: 'A', t: 'Keep it, because it matches what several residents said about evening services.' },
        { k: 'B', t: 'Ask the AI tool for the source of the quote and keep it if one is given.' },
        { k: 'C', t: 'Keep it, but label it in the briefing as a quote generated by AI.' },
        { k: 'D', t: 'Remove the quote unless she finds it in the original responses.' }
      ]
    },
    {
      id: '5',
      topic: S3,
      lvl: 3,
      pts: 2,
      text: '14:00. The AI tool drafted these. Which one must a named person review before it leaves the team?',
      options: [
        { k: 'A', t: 'A reply to a resident about their complaint' },
        { k: 'B', t: 'Three ideas for the briefing title' },
        { k: 'C', t: 'An outline Maya will rewrite in her own words' },
        { k: 'D', t: "Notes for the team's internal planning meeting" }
      ]
    },
    {
      id: '6',
      type: 'fill',
      topic: S3,
      lvl: 3,
      pts: 2,
      text: 'The AI tool has analysed the consultation responses about Route 12. Who does each step?',
      items: [
        'Sorts 1,124 responses into themes: □',
        'Checks the theme counts against the records: □',
        'Decides whether Route 12 closes: □',
        'Signs the reply to residents about the decision: □'
      ],
      choices: ['AI tool', 'Named person']
    },
    {
      id: '7',
      topic: S4,
      lvl: 3,
      pts: 2,
      text: '16:00. A wrong figure reached senior leaders. The AI tool produced it. Maya put it in the briefing. Her manager, Tom, approved the briefing and sent it on. Who should have checked the figure first?',
      options: [
        { k: 'A', t: 'Maya' },
        { k: 'B', t: 'Tom' },
        { k: 'C', t: 'The AI tool' },
        { k: 'D', t: 'The AI provider' }
      ]
    },
    {
      id: '8',
      topic: S4,
      lvl: 3,
      pts: 2,
      text: "Maya's manager says: \"Add a line saying the figures were produced by AI, so we are not responsible if they are wrong.\" What is the problem?",
      options: [
        { k: 'A', t: 'Nothing. With the line in place, responsibility for the figures moves to the tool.' },
        { k: 'B', t: 'Flagging AI use is right, but Maya and the Authority still answer for the figures.' },
        { k: 'C', t: 'Flagging AI use is right, and it tells readers to check the figures themselves.' },
        { k: 'D', t: 'The line should name the AI provider, so the provider shares the liability.' }
      ]
    },
    {
      id: '9',
      topic: S5,
      lvl: 3,
      pts: 2,
      text: '17:30. Which plan is the most responsible way to finish the briefing?',
      options: [
        { k: 'A', t: 'Summarise only the published report, check every figure against the records, note where AI was used, and send it to the director to decide.' },
        { k: 'B', t: "Summarise the anonymised residents' responses as well, check every figure, note where AI was used, and send it to the director to decide." },
        { k: 'C', t: 'Summarise only the published report, check the figures against the sources the AI cites, note where AI was used, and send it to the director to decide.' },
        { k: 'D', t: 'Summarise only the published report, check every figure against the records, ask a colleague to proofread, and send it to the director to decide.' }
      ]
    },
    {
      id: '10',
      type: 'match',
      topic: S5,
      lvl: 3,
      pts: 2,
      text: 'Match each risk with the step that deals with it. Two steps are not needed.',
      leftTitle: 'Risk',
      rightTitle: 'Step',
      left: [
        { k: '1', t: "The summary gives a total that differs from the Authority's records" },
        { k: '2', t: 'Senior leaders assume Maya wrote every section herself' }
      ],
      right: [
        { k: 'A', t: 'Check it against the source data' },
        { k: 'B', t: 'Say in the briefing where AI was used' },
        { k: 'C', t: 'Ask the AI tool to double-check its own total' },
        { k: 'D', t: 'Delete the chat after use' }
      ]
    }
  ]
};
