import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const query = (req.query.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing query parameter: query" });
    return;
  }

  const pullpushParams = new URLSearchParams({
    subreddit: "SomebodyMakeThis",
    q: query,
    size: "10",
  });
  const pullpushUrl = `https://api.pullpush.io/reddit/search/submission/?${pullpushParams.toString()}`;

  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  function normalizePermalink(value) {
    const raw = String(value || "").trim();
    if (!raw) return "https://www.reddit.com/r/SomebodyMakeThis/";
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    if (raw.startsWith("/")) return `https://www.reddit.com${raw}`;
    return `https://www.reddit.com/${raw.replace(/^reddit\.com\//, "")}`;
  }

  function extractText(value, maxChars) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async function analyzeWithDeepSeek(post) {
    if (!deepseekKey) {
      return {
        pain_intensity: null,
        summary: null,
        attention_score: null,
        error: "DEEPSEEK_API_KEY not set",
      };
    }

    const title = String(post.title || "");
    const body = String(post.selftext || "");
    const prompt = [
      "You are analyzing a Reddit post to detect user pain and product opportunity.",
      "Return ONLY valid JSON with exactly these keys:",
      "- pain_intensity: number (1-10)",
      "- attention_score: number (1-10, predicted attention/discussion level)",
      "- summary: string (one-sentence English summary of the need)",
      "",
      `Title: ${title}`,
      `Body: ${body}`,
    ].join("\n");

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseekKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        messages: [
          { role: "system", content: "Return JSON only. No markdown, no code fences." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        pain_intensity: null,
        summary: null,
        attention_score: null,
        error: `DeepSeek request failed: ${response.status}${text ? ` - ${text.slice(0, 200)}` : ""}`,
      };
    }

    const json = await response.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : "";

    try {
      const parsed = JSON.parse(String(content || "").trim());
      const intensityNum = Number(parsed.pain_intensity);
      const pain_intensity = Number.isFinite(intensityNum)
        ? Math.max(1, Math.min(10, Math.round(intensityNum)))
        : null;
      const attentionNum = Number(parsed.attention_score);
      const attention_score = Number.isFinite(attentionNum)
        ? Math.max(1, Math.min(10, Math.round(attentionNum)))
        : null;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : null;
      return { pain_intensity, summary, attention_score };
    } catch {
      return {
        pain_intensity: null,
        summary: null,
        attention_score: null,
        error: "Failed to parse DeepSeek JSON",
      };
    }
  }

  try {
    const response = await fetch(pullpushUrl, {
      headers: {
        "User-Agent": "IdeaRadar/1.0"
      }
    });

    if (!response.ok) {
      res.status(response.status).json({
        error: `PullPush API request failed with status ${response.status}`
      });
      return;
    }

    const data = await response.json();
    const rawResults = Array.isArray(data && data.data)
      ? data.data
      : (Array.isArray(data) ? data : []);

    const baseResults = rawResults.map((item) => {
      const title = String(item && item.title ? item.title : "Untitled post");
      const score = Number.isFinite(item && item.score) ? item.score : 0;
      const selftext = extractText(item && item.selftext ? item.selftext : "", 200);
      const permalink = normalizePermalink(item && (item.permalink || item.full_link || item.url));
      return { title, selftext, score, permalink };
    });

    const analyzed = await Promise.all(
      baseResults.map(async (post) => {
        const ai = await analyzeWithDeepSeek(post);
        return { ...post, ai };
      })
    );

    res.status(200).json({ results: analyzed });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch from PullPush or analyze with AI",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
