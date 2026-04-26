import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function getBearerToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

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

function emptyAi(error) {
  return {
    pain_intensity: null,
    summary: null,
    attention_score: null,
    error,
  };
}

async function analyzeWithDeepSeek(post) {
  if (!DEEPSEEK_API_KEY) return emptyAi("DEEPSEEK_API_KEY is not configured");

  const prompt = [
    "Analyze this Reddit post and return JSON only.",
    "Required keys:",
    "- pain_intensity: number 1-10",
    "- attention_score: number 1-10 (expected discussion/attention level)",
    "- summary: one-sentence English summary",
    "",
    `Title: ${post.title || ""}`,
    `Body: ${post.selftext || ""}`,
  ].join("\n");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Return strict JSON only, no markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return emptyAi(`DeepSeek request failed: ${response.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(String(content).trim());
    const pain = Number(parsed.pain_intensity);
    const attention = Number(parsed.attention_score);
    return {
      pain_intensity: Number.isFinite(pain) ? Math.max(1, Math.min(10, Math.round(pain))) : null,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
      attention_score: Number.isFinite(attention) ? Math.max(1, Math.min(10, Math.round(attention))) : null,
    };
  } catch {
    return emptyAi("Failed to parse DeepSeek JSON");
  }
}

async function getAuthenticatedUser(req, res) {
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Supabase service credentials are not configured." });
    return null;
  }
  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return null;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Invalid or expired token." });
    return null;
  }
  return { user: data.user, token };
}

async function loadProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id,search_credits,is_pro,pro_expiry_date,email,is_admin")
    .eq("id", userId)
    .single();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }
  return data;
}

function isProActive(profile) {
  if (!profile?.is_pro || !profile?.pro_expiry_date) return false;
  return new Date(profile.pro_expiry_date).getTime() > Date.now();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const query = String(req.query.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "Missing query parameter: query" });
    return;
  }

  const auth = await getAuthenticatedUser(req, res);
  if (!auth) return;

  try {
    const profile = await loadProfile(auth.user.id);
    const proActive = isProActive(profile);
    const isAdmin = Boolean(profile?.is_admin);

    if (!proActive && !isAdmin) {
      const credits = Number(profile.search_credits || 0);
      if (credits <= 0) {
        res.status(403).json({ error: "Insufficient credits. Please purchase more." });
        return;
      }
      const { error: updateError } = await supabaseAdmin
        .from("profiles")
        .update({ search_credits: credits - 1, updated_at: new Date().toISOString() })
        .eq("id", auth.user.id);
      if (updateError) {
        throw new Error(`Failed to decrement credits: ${updateError.message}`);
      }
    }

    const params = new URLSearchParams({
      subreddit: "SomebodyMakeThis",
      q: query,
      size: "10",
    });
    const pullpushUrl = `https://api.pullpush.io/reddit/search/submission/?${params.toString()}`;
    const response = await fetch(pullpushUrl, {
      headers: { "User-Agent": "IdeaRadar/1.0" },
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `PullPush API request failed with status ${response.status}` });
      return;
    }

    const pullpushData = await response.json();
    const rawResults = Array.isArray(pullpushData?.data)
      ? pullpushData.data
      : (Array.isArray(pullpushData) ? pullpushData : []);

    const baseResults = rawResults.map((item) => ({
      title: String(item?.title || "Untitled post"),
      selftext: extractText(item?.selftext || "", 200),
      score: Number.isFinite(item?.score) ? item.score : 0,
      permalink: normalizePermalink(item?.permalink || item?.full_link || item?.url),
    }));

    const results = await Promise.all(baseResults.map(async (post) => ({ ...post, ai: await analyzeWithDeepSeek(post) })));
    const latestProfile = await loadProfile(auth.user.id);
    res.status(200).json({
      results,
      profile: {
        email: auth.user.email || latestProfile.email || "",
        search_credits: Number(latestProfile.search_credits || 0),
        is_pro: Boolean(latestProfile.is_pro),
        pro_expiry_date: latestProfile.pro_expiry_date,
        pro_active: isProActive(latestProfile),
        is_admin: Boolean(latestProfile.is_admin),
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to process search request.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
