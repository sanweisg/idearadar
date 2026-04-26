import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function getToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
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
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Supabase service credentials are not configured." });
    return;
  }
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }
  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !authData?.user) {
    res.status(401).json({ error: "Invalid or expired token." });
    return;
  }
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("email,search_credits,is_pro,pro_expiry_date")
    .eq("id", authData.user.id)
    .single();
  if (error || !data) {
    res.status(404).json({ error: "Profile not found." });
    return;
  }
  res.status(200).json({ profile: { ...data, pro_active: isProActive(data) } });
}
