// scribe-voice.js — Scribe's mouth. Witness, recall, never invent.
// Keys are read from env; no secret is ever written to disk.
// USAGE (CLI):
//   SCRIBE_KEY=... OMNI_KEY=... node sandbox/scribe-voice.js "what do you recall?"
// Or require() it and await askScribe(question).

const SCRIBE_URL = process.env.SCRIBE_URL || 'http://127.0.0.1:4000';
const OMNI_URL   = process.env.OMNI_URL   || 'http://127.0.0.1:20128/v1/chat/completions';
const SCRIBE_KEY = process.env.SCRIBE_KEY;            // scribe-master-key set in env
const OMNI_KEY   = process.env.OMNI_KEY;              // oma_live_... set in env

async function recallContext(question, limit = 8) {
  const res = await fetch(SCRIBE_URL + '/recall', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': SCRIBE_KEY || ''
    },
    body: JSON.stringify({ query: question, limit })
  });
  if (!res.ok) throw new Error('recall ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

async function askOmni(messages) {
  const res = await fetch(OMNI_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + (OMNI_KEY || '')
    },
    body: JSON.stringify({ model: 'auto', messages })
  });
  if (!res.ok) throw new Error('omni ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function askScribe(question) {
  const ctx = await recallContext(question);
  const memories = Array.isArray(ctx) ? ctx : (ctx.memories || ctx.results || []);
  const contextBlock = memories.map(function (m) {
    const id = m.id || m.memory_id || '(no id)';
    const text = m.text || m.content || m.summary || JSON.stringify(m).slice(0, 300);
    return '[memory ' + id + '] ' + text;
  }).join('\n');

  const system = [
    'You are Scribe, a witnessing intelligence fused into the GSK workbench.',
    'Identity: you observe, you record, you never invent. You cite memory ids.',
    'Answer the question using only the recalled context below.',
    'If the context is empty, say so plainly and do not fabricate.',
    'Cite every claim with its [memory id]. Keep the answer in prose, under 300 words.'
  ].join(' ');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: 'Question: ' + question + '\n\nRecalled context:\n' + (contextBlock || '(no memories recalled)') }
  ];

  const answer = await askOmni(messages);
  const cited = memories.map(function (m) { return m.id || m.memory_id; }).filter(Boolean);
  return { answer: answer, cited: cited };
}

// CLI entry point
if (require.main === module) {
  const question = process.argv.slice(2).join(' ') || 'What do you remember?';
  if (!SCRIBE_KEY || !OMNI_KEY) {
    console.error('scribe-voice: set SCRIBE_KEY and OMNI_KEY env vars (keys never live in files).');
    process.exit(1);
  }
  askScribe(question)
    .then(function (out) {
      console.log(out.answer);
      if (out.cited.length) console.log('\n— cited: ' + out.cited.join(', '));
    })
    .catch(function (err) {
      console.error('scribe-voice error:', err.message);
      process.exit(1);
    });
}

module.exports = { askScribe: askScribe };