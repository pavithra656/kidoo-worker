 export default {
  async fetch(request, env) {
    // Allow requests from your GitHub Pages site
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

    // Book an appointment: checks the slot is free, then saves it.
    // POST /book with JSON body: { patient_name, patient_email, appointment_date, appointment_time, reason }
    if (request.method === 'POST' && url.pathname === '/book') {
      try {
        const body = await request.json();
        const { patient_name, patient_email, appointment_date, appointment_time, reason } = body;

        // Basic validation - required fields must be present
        if (!patient_name || !patient_email || !appointment_date || !appointment_time) {
          return new Response(JSON.stringify({ error: 'Missing required fields: patient_name, patient_email, appointment_date, appointment_time' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Check if this exact date+time is already booked (status = 'booked', not cancelled)
        const existing = await env.DB.prepare(
          "SELECT id FROM appointments WHERE appointment_date = ? AND appointment_time = ? AND status = 'booked'"
        ).bind(appointment_date, appointment_time).first();

        if (existing) {
          return new Response(JSON.stringify({ error: 'That slot is already booked. Please choose a different time.' }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Slot is free - insert the booking
        const result = await env.DB.prepare(
          "INSERT INTO appointments (patient_name, patient_email, appointment_date, appointment_time, reason) VALUES (?, ?, ?, ?, ?)"
        ).bind(patient_name, patient_email, appointment_date, appointment_time, reason || null).run();

        // Send an email notification (best-effort - booking still succeeds even if email fails)
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            },
            body: JSON.stringify({
              from: 'Kidoo <onboarding@resend.dev>',
              to: 'kidooappointment@gmail.com',
              subject: `New Appointment: ${patient_name} on ${appointment_date}`,
              html: `
                <h2>New Appointment Booked 📅</h2>
                <p><b>Name:</b> ${patient_name}</p>
                <p><b>Email:</b> ${patient_email}</p>
                <p><b>Date:</b> ${appointment_date}</p>
                <p><b>Time:</b> ${appointment_time}</p>
                <p><b>Reason:</b> ${reason || 'Not specified'}</p>
              `,
            }),
          });
        } catch (emailErr) {
          // Don't fail the booking just because the email failed
          console.log('Email send failed:', emailErr.message);
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Appointment booked for ${appointment_date} at ${appointment_time}`,
          appointment_id: result.meta.last_row_id,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (bookErr) {
        return new Response(JSON.stringify({ error: bookErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // View all appointments (simple admin check)
    // GET /appointments
    // TEMP DEBUG: test Groq directly
if (request.method === 'GET' && url.pathname === '/debug-groq') {
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  const groqData = await groqRes.json();
  return new Response(JSON.stringify({ status: groqRes.status, data: groqData }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
    if (request.method === 'GET' && url.pathname === '/appointments') {
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM appointments ORDER BY appointment_date, appointment_time"
        ).all();
        return new Response(JSON.stringify(results, null, 2), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (listErr) {
        return new Response(JSON.stringify({ error: listErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
        throw new Error('Groq status: ' + groqRes.status + ' | Response: ' + JSON.stringify(groqData));
      } catch (groqErr) {
        // Fallback to Gemini
        const systemMsg = history.find(m => m.role === 'system');
        const chatMsgs = history.filter(m => m.role !== 'system');

        const geminiContents = chatMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_API_KEY}`,
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
        const reply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text
  || "DEBUG - Gemini status: " + geminiRes.status + " | Response: " + JSON.stringify(geminiData) + " | Groq error was: " + groqErr.message;

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
