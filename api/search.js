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

  const params = new URLSearchParams({
    q: query,
    restrict_sr: "on",
    limit: "10",
    raw_json: "1"
  });
  const redditUrl = `https://www.reddit.com/r/SomebodyMakeThis/search.json?${params.toString()}`;

  try {
    const response = await fetch(redditUrl, {
      headers: {
        "User-Agent": "IdeaRadar/1.0"
      }
    });

    if (!response.ok) {
      res.status(response.status).json({
        error: `Reddit API request failed with status ${response.status}`
      });
      return;
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch Reddit API",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
