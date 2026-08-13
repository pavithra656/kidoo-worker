export default {
  async fetch(request, env) {
    // Allow requests from your GitHub Pages site
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // One-time setup route: visit this URL once in your browser to create the table.
    // GET https://kidoo-worker.pavithrasureshguttal.workers.dev/setup
    if (request.method === 'GET' && url.pathname === '/setup') {
      try {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_name TEXT NOT NULL, patient_email TEXT NOT NULL, appointment_date TEXT NOT NULL, appointment_time TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'booked', created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        ).run();
        return new Response('Table created (or already existed). Setup done!', {
          headers: corsHeaders,
        });
      } catch (setupErr) {
        return new Response('Setup error: ' + setupErr.message, {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const { history } = await request.json();

      // Try Groq first
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: history,
          }),
        });

        const groqData = await groqRes.json();
        if (groqRes.ok && groqData.choices) {
          return new Response(JSON.stringify(groqData), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Groq failed, falling back to Gemini');
      } catch (groqErr) {
        // Fallback to Gemini
        const systemMsg = history.find(m => m.role === 'system');
        const chatMsgs = history.filter(m => m.role !== 'system');

        const geminiContents = chatMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
              contents: geminiContents,
            }),
          }
        );

        const geminiData = await geminiRes.json();
        const reply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I'm having trouble right now!";

        // Reshape into the same format the frontend expects (OpenAI-style)
        return new Response(JSON.stringify({
          choices: [{ message: { content: reply } }],
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};

