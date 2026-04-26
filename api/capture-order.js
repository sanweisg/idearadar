import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const PAYPAL_API_BASE = process.env.VERCEL_ENV === "production"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const PLAN_CONFIG = {
  "Single Search": { amount: "5.00", credits: 1, type: "credits" },
  "Explorer Pack": { amount: "20.00", credits: 5, type: "credits" },
  "Builder Pack": { amount: "45.00", credits: 15, type: "credits" },
  "Founder Pack": { amount: "90.00", credits: 45, type: "credits" },
  "Pro Monthly": { amount: "9.99", type: "pro" },
  "Deep Report": { amount: "14.99", type: "report" },
};

function getToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

function addOneMonthIso(isoDate) {
  const start = isoDate ? new Date(isoDate) : new Date();
  const base = Number.isNaN(start.getTime()) ? new Date() : start;
  const next = new Date(base.getTime());
  next.setMonth(next.getMonth() + 1);
  return next.toISOString();
}

async function getPayPalAccessToken() {
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`PayPal token request failed: ${response.status} ${detail}`);
  }
  const json = await response.json();
  if (!json.access_token) throw new Error("PayPal access token missing.");
  return json.access_token;
}

async function capturePayPalOrder(orderID) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${orderID}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`PayPal capture failed: ${response.status} ${detail}`);
  }
  return response.json();
}

function parseCapturedAmount(capture) {
  const units = Array.isArray(capture?.purchase_units) ? capture.purchase_units : [];
  const amount = units[0]?.payments?.captures?.[0]?.amount?.value || units[0]?.amount?.value;
  return amount ? Number(amount) : NaN;
}

function getDeepReportPrompt(sourceTitle, sourceContent) {
  return [
    "Generate a startup opportunity deep report in JSON.",
    "Return ONLY strict JSON with keys:",
    "executive_summary",
    "market_potential",
    "competitive_landscape",
    "target_user_persona",
    "monetization_strategy",
    "action_plan",
    "recommended_tech_stack",
    "risk_mitigation",
    "",
    "Requirements:",
    "- market_potential should include TAM, SAM, SOM and growth trends",
    "- target_user_persona should include exactly 2 personas",
    "- action_plan should include 7-day, 30-day, 90-day steps",
    "",
    `Title: ${sourceTitle || ""}`,
    `Content: ${sourceContent || ""}`,
  ].join("\n");
}

async function generateDeepReport(sourceTitle, sourceContent) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not configured.");
  }
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are a precise startup analyst. Return strict JSON only." },
        { role: "user", content: getDeepReportPrompt(sourceTitle, sourceContent) },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek report request failed: ${response.status} ${detail}`);
  }
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(String(content).trim());
  } catch {
    throw new Error("Failed to parse DeepSeek report JSON.");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!supabaseAdmin) {
    res.status(500).json({ error: "Supabase service credentials are not configured." });
    return;
  }
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    res.status(500).json({ error: "PayPal credentials are not configured." });
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

    // ====== 新增：管理员免费生成 Deep Report ======
    const { item_name: preItemName, source_title: preSourceTitle, source_content: preSourceContent } = req.body || {};
  
    if (preItemName === "Deep Report") {
      // 查询用户是否是管理员
      const { data: adminProfile, error: adminProfileError } = await supabaseAdmin
        .from("profiles")
        .select("is_admin")
        .eq("id", authData.user.id)
        .single();
      
      if (!adminProfileError && adminProfile && adminProfile.is_admin) {
        // 管理员直接生成报告，跳过 PayPal
        try {
          const reportJson = await generateDeepReport(preSourceTitle, preSourceContent);
          const { data: reportRow, error: insertError } = await supabaseAdmin
            .from("reports")
            .insert({
              user_id: authData.user.id,
              pain_point_title: String(preSourceTitle || ""),
              report_content: reportJson,
              price_paid: 0,
              created_at: new Date().toISOString()
            })
            .select("id,report_content,created_at")
            .single();
          
          if (insertError || !reportRow) {
            throw new Error(`Failed to save report: ${insertError?.message || "unknown"}`);
          }
          
          return res.status(200).json({
            success: true,
            item_name: "Deep Report",
            admin_bypass: true,
            report_id: reportRow.id,
            report: reportRow.report_content,
            created_at: reportRow.created_at
          });
        } catch (error) {
          return res.status(500).json({
            error: "Admin report generation failed.",
            detail: error instanceof Error ? error.message : "Unknown error"
          });
        }
      }
    }
    // ====== 新增结束 ======
    const { orderID, item_name: itemName, source_title: sourceTitle, source_content: sourceContent } = req.body || {};
    if (!itemName) {
      res.status(400).json({ error: "Missing item_name." });
      return;
    }
    // 注意：管理员 Deep Report 不需要 orderID，已经在上面处理了
    if (!orderID && itemName !== "Deep Report") {
      res.status(400).json({ error: "Missing orderID." });
      return;
    }
    
  const config = PLAN_CONFIG[itemName];
  if (!config) {
    res.status(400).json({ error: "Unsupported item_name." });
    return;
  }

  try {
    const captured = await capturePayPalOrder(orderID);
    const paidAmount = parseCapturedAmount(captured);
    const expectedAmount = Number(config.amount);
    if (!Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.01) {
      res.status(400).json({ error: "Captured amount does not match plan pricing." });
      return;
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id,search_credits,is_pro,pro_expiry_date")
      .eq("id", authData.user.id)
      .single();
    if (profileError || !profile) {
      res.status(500).json({ error: "Failed to load user profile." });
      return;
    }

    let reportPayload = null;
    if (config.type === "credits") {
      const currentCredits = Number(profile.search_credits || 0);
      const { error } = await supabaseAdmin
        .from("profiles")
        .update({
          search_credits: currentCredits + config.credits,
          updated_at: new Date().toISOString(),
        })
        .eq("id", authData.user.id);
      if (error) throw new Error(`Failed to add credits: ${error.message}`);
    } else if (config.type === "pro") {
      const now = new Date();
      const currentExpiry = profile.pro_expiry_date ? new Date(profile.pro_expiry_date) : null;
      const baseDate = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry.toISOString() : now.toISOString();
      const nextExpiry = addOneMonthIso(baseDate);
      const { error } = await supabaseAdmin
        .from("profiles")
        .update({
          is_pro: true,
          pro_expiry_date: nextExpiry,
          updated_at: now.toISOString(),
        })
        .eq("id", authData.user.id);
      if (error) throw new Error(`Failed to activate Pro: ${error.message}`);
    } else if (config.type === "report") {
      const reportJson = await generateDeepReport(sourceTitle, sourceContent);
      const { data: reportRow, error } = await supabaseAdmin
        .from("reports")
        .insert({
          user_id: authData.user.id,
          item_name: itemName,
          source_title: String(sourceTitle || ""),
          source_content: String(sourceContent || ""),
          report_json: reportJson,
        })
        .select("id,report_json,created_at")
        .single();
      if (error || !reportRow) throw new Error(`Failed to save report: ${error?.message || "unknown error"}`);
      reportPayload = { report_id: reportRow.id, report: reportRow.report_json, created_at: reportRow.created_at };
    }

    const { data: updatedProfile } = await supabaseAdmin
      .from("profiles")
      .select("search_credits,is_pro,pro_expiry_date")
      .eq("id", authData.user.id)
      .single();

    res.status(200).json({
      success: true,
      item_name: itemName,
      profile: updatedProfile || null,
      ...(reportPayload || {}),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to capture order and provision benefits.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
