// Supabase Edge Function: draw-winner
// Расположение: supabase/functions/draw-winner/index.ts
// Служит для проведения честного транзакционного розыгрыша на сервере.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // Обработка OPTIONS запроса для CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, message: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");

    // Инициализируем клиент со сверхмощными правами (SUPABASE_SERVICE_ROLE_KEY)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
       return new Response(
        JSON.stringify({ success: false, message: "Server configuration error: missing env keys" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      }
    });

    // 1. ПРОВЕРКА РОЛИ АДМИНИСТРАТОРА (Проблема №3)
    // Верифицируем JWT токен пользователя в Supabase Auth
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(
        JSON.stringify({ success: false, message: "Unauthorized admin access (invalid token)" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Дополнительная верификация: существует ли пользователь в таблице admin_users
    const { data: adminProfile, error: adminProfileError } = await supabaseClient
      .from("admin_users")
      .select("id, username")
      .eq("id", user.id)
      .maybeSingle();

    if (adminProfileError || !adminProfile) {
      return new Response(
        JSON.stringify({ success: false, message: "Access forbidden: User is not mapped to admin_users table" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Читаем тело POST запроса
    const { action } = await req.json().catch(() => ({ action: "draw" }));

    if (action !== "drawWinner" && action !== "draw") {
      return new Response(
        JSON.stringify({ success: false, message: `Unsupported action: ${action}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Вызываем хранимую процедуру в СУБД (RPC),
    // передавая верифицированный email администратора в аудит-логи
    const { data, error: rpcError } = await supabaseClient.rpc("draw_winner", {
      admin_email: user.email || "admin"
    });

    if (rpcError) {
      throw rpcError;
    }

    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error.message || "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
