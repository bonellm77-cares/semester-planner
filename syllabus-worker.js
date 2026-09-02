// Cloudflare Worker: syllabus date extraction via Workers AI
// Deploy this in your Cloudflare dashboard as a new Worker, with Workers AI bound.
//
// Setup (one-time, in the Cloudflare dashboard):
// 1. Workers & Pages -> Create -> Worker -> paste this code -> Deploy
// 2. Worker -> Settings -> Bindings -> Add binding -> Workers AI -> name it "AI"
//    (this is what makes env.AI work below, no API key needed)
// 3. Copy the Worker's URL (looks like https://syllabus-worker.<you>.workers.dev)
//    and put it in the app's WORKER_URL constant.

export default {
  async fetch(request, env) {
    // CORS so your app (running from a local file or Pages) can call this
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response('Use POST', { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Expected JSON body with a "text" field' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const syllabusText = (body.text || '').slice(0, 20000); // guard against huge inputs
    if (!syllabusText.trim()) {
      return new Response(JSON.stringify({ error: 'No text provided' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const prompt = `You are extracting dated items from a college syllabus for a student's calendar app.

Today's date is ${today}. The syllabus text is below. Find every dated item: assignments, quizzes, exams, readings with due dates, and major projects/papers.

Return ONLY a JSON array, no other text, no markdown fences. Each item:
{
  "title": "short description, under 8 words",
  "date": "YYYY-MM-DD",
  "flagged": true or false (true only for major long-term work: final papers, capstones, theses, multi-week projects — NOT regular homework or quizzes),
  "confidence": "high" or "low" (low if the date was ambiguous, relative like 'week 7', or you had to infer the year)
}

If a date is relative (e.g. "week 7") and you can't confidently resolve it, skip that item rather than guessing.
If no year is stated, assume the current academic year based on today's date.

Syllabus text:
"""
${syllabusText}
"""`;

    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
      });

      let raw = null;
      if (aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message && typeof aiResponse.choices[0].message.content === 'string') {
        raw = aiResponse.choices[0].message.content;
      } else if (typeof aiResponse.response === 'string') {
        raw = aiResponse.response;
      } else if (aiResponse.response && typeof aiResponse.response === 'object' && typeof aiResponse.response.text === 'string') {
        raw = aiResponse.response.text;
      }
      if (!raw) {
        raw = JSON.stringify(aiResponse); // last resort, for debugging if this still isn't right
      }
      raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();

      let items;
      try {
        items = JSON.parse(raw);
      } catch (parseErr) {
        return new Response(JSON.stringify({ error: 'Model returned unparseable output', raw, rawType: typeof aiResponse.response, responseKeys: Object.keys(aiResponse || {}) }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (!Array.isArray(items)) {
        return new Response(JSON.stringify({ error: 'Expected an array from the model', raw }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // basic validation/cleanup so a malformed item can't break the frontend
      const cleaned = items
        .filter(it => it && typeof it.title === 'string' && typeof it.date === 'string')
        .filter(it => /^\d{4}-\d{2}-\d{2}$/.test(it.date))
        .map(it => ({
          title: it.title.slice(0, 80),
          date: it.date,
          flagged: !!it.flagged,
          confidence: it.confidence === 'low' ? 'low' : 'high',
        }))
        .slice(0, 40);

      return new Response(JSON.stringify({ items: cleaned }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'AI call failed: ' + err.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
