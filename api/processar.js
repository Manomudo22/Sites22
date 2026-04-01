export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { pdfText, instruction } = req.body;

  if (!pdfText || !instruction) {
    return res.status(400).json({ error: 'pdfText e instruction são obrigatórios' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Chave de API não configurada no servidor' });
  }

  // Divide o texto em partes de ~3000 caracteres respeitando quebras de linha
  function splitIntoChunks(text, maxChars = 3000) {
    const paragraphs = text.split('\n');
    const chunks = [];
    let current = '';

    for (const line of paragraphs) {
      if ((current + '\n' + line).length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = line;
      } else {
        current += '\n' + line;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  async function callGemini(chunkText, chunkIndex, totalChunks) {
    const isFirst = chunkIndex === 0;
    const isLast = chunkIndex === totalChunks - 1;

    let contextNote = '';
    if (totalChunks > 1) {
      contextNote = `\n\n(Esta é a parte ${chunkIndex + 1} de ${totalChunks} do documento.)`;
    }

    const prompt = `Você é um assistente especializado em processar e editar documentos.

CONTEÚDO DO PDF (parte ${chunkIndex + 1} de ${totalChunks}):
${chunkText}${contextNote}

---

INSTRUÇÃO: ${instruction}

${isFirst && totalChunks > 1 ? 'Processe esta parte do documento conforme a instrução. O resultado será combinado com as outras partes.' : ''}
${!isFirst && !isLast ? 'Continue processando esta parte do documento conforme a instrução.' : ''}
${isLast && totalChunks > 1 ? 'Esta é a última parte. Processe conforme a instrução.' : ''}

Responda APENAS com o conteúdo processado, bem formatado. Se for responder questões, numere as respostas. Não adicione explicações sobre o que você fez.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.3 }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Erro HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Aguarda um tempo entre requisições pra evitar rate limit
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  try {
    const chunks = splitIntoChunks(pdfText, 3000);
    const results = [];

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(2000); // 2 segundos entre cada parte
      const result = await callGemini(chunks[i], i, chunks.length);
      results.push(result);
    }

    const finalResult = results.join('\n\n--- Continuação ---\n\n');
    return res.status(200).json({ result: finalResult, parts: chunks.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
