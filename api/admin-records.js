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

  const { data: me, error: meError } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", authData.user.id)
    .single();
  if (meError || !me?.is_admin) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }

  const [{ data: users }, { data: reports }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id,email,search_credits,is_pro,pro_expiry_date,is_admin,created_at")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("reports")
      .select("id,user_id,item_name,source_title,created_at")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  res.status(200).json({
    users: users || [],
    reports: reports || [],
  });
}
