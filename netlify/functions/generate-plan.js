exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing GEMINI_API_KEY' }) };
    }
    const body = JSON.parse(event.body || '{}');
    // Basic validation for required fields
    const required = ['age', 'biologicalSex', 'height', 'weight', 'fitnessExperience', 'fitnessGoals'];
    const missing = required.filter((k) => body[k] === undefined || body[k] === '');
    if (missing.length) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Missing required fields', details: missing.join(', ') })
      };
    }

    const prompt = `Create a personalized fitness and diet plan based on the following user information:
- Age: ${body.age}
- Biological Sex: ${body.biologicalSex}
- Height: ${body.height} cm
- Weight: ${body.weight} kg
- Fitness Experience: ${body.fitnessExperience}
- Dietary Restrictions: ${body.dietaryRestrictions || 'None'}
- Fitness Goals: ${body.fitnessGoals}
${body.oxygenSaturation ? `- Oxygen Saturation: ${body.oxygenSaturation}%` : ''}
${body.bloodPressure ? `- Blood Pressure: ${body.bloodPressure}` : ''}
${body.waterIntake ? `- Daily Water Intake: ${body.waterIntake}L` : ''}
${body.calorieIntake ? `- Daily Calorie Intake: ${body.calorieIntake} kcal` : ''}

Please provide a detailed 7-day fitness and nutrition plan that includes:
1. Daily workout routines with sets and reps
2. Meal plans with portion sizes
3. Rest days
4. Hydration goals
5. Additional recommendations based on the user's data`;

    function withTimeout(promise, ms, controller) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          controller && controller.abort();
          reject(new Error(`Request timed out after ${ms}ms`));
        }, ms);
        promise.then(
          (v) => { clearTimeout(t); resolve(v); },
          (e) => { clearTimeout(t); reject(e); }
        );
      });
    }

    async function callGeminiREST(model, version = 'v1', timeoutMs = 20000) {
      const modelPath = model.startsWith('models/') ? model : `models/${model}`;
      const url = `https://generativelanguage.googleapis.com/${version}/${modelPath}:generateContent`;
      const ctrl = new AbortController();
      const resp = await withTimeout(fetch(url + `?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ]
        }),
        signal: ctrl.signal
      }), timeoutMs, ctrl);
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status} ${resp.statusText} at ${url}: ${txt}`);
      }
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
      if (!text) throw new Error('Empty response from model');
      return text;
    }

    async function listModels(version = 'v1') {
      const url = `https://generativelanguage.googleapis.com/${version}/models?key=${encodeURIComponent(apiKey)}`;
      const ctrl = new AbortController();
      const resp = await withTimeout(fetch(url, { signal: ctrl.signal }), 8000, ctrl);
      if (!resp.ok) throw new Error(`ListModels failed at ${url}: ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      return data?.models || [];
    }

    // Resolve a working model dynamically
    const preferred = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-preview-05-20',
      'gemini-2.5-pro-preview-03-25',
      'gemini-2.5-pro-preview-05-06',
      'gemini-pro'
    ];

    let text;
    let lastErr;
    try {
      const isLocal = (process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL) ? true : false;
      const apiVersions = isLocal ? ['v1beta'] : ['v1beta', 'v1'];
      const deadline = Date.now() + (isLocal ? 30000 : 55000);
      const perCallMs = isLocal ? 20000 : 20000;
      // Local dev: single, known-good model only (REST with tight config)
      if (isLocal) {
        try {
          const ctrl = new AbortController();
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
          const resp = await withTimeout(fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 1024, temperature: 0.7, topP: 0.95 }
            }),
            signal: ctrl.signal
          }), 15000, ctrl);
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Local REST HTTP ${resp.status}: ${txt}`);
          }
          const data = await resp.json();
          const t = (data?.candidates?.[0]?.content?.parts || [])
            .map(p => (typeof p === 'string' ? p : p.text || ''))
            .join('');
          if (!t) throw new Error(`Empty model response: ${JSON.stringify(data).slice(0,500)}`);
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, plan: t })
          };
        } catch (e) {
          return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: 'Local model call failed', details: e.message })
          };
        }
      }
      // Production path below
      if (!text) {
      // Step 1: List models across versions and try available ones first (short timeouts)
      for (const apiV of apiVersions) {
        try {
          const models = await listModels(apiV);
          const supported = models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
          const twopointfive = supported.filter(m => m.name.includes('2.5-'));
          const others = supported.filter(m => !m.name.includes('2.5-'));
          const byPreference = [...twopointfive, ...others];
          const toTry = isLocal ? twopointfive.slice(0, 1) : byPreference;
          for (const m of toTry) {
            if (Date.now() > deadline) throw new Error('Global timeout before model attempts');
            try {
              text = await callGeminiREST(m.name, apiV, perCallMs);
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (text) break;
        } catch (e) {
          lastErr = e;
        }
      }
      // Step 2: Fallback to preferred list (no 1.5 models)
      if (!text) {
        for (const apiV of apiVersions) {
          for (const name of preferred) {
            if (isLocal && !name.includes('2.5-') && name !== 'gemini-pro') continue;
            if (Date.now() > deadline) throw new Error('Global timeout before preferred attempts');
            try {
              text = await callGeminiREST(name, apiV, perCallMs);
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (text) break;
        }
      }
      }
    } catch (outer) {
      lastErr = outer;
    }

    if (!text) throw new Error(`All model attempts failed. Last error: ${lastErr?.message || 'unknown'}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, plan: text })
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Failed to generate fitness plan', details: err.message })
    };
  }
};
