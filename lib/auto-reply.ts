import { createServiceClient } from "@/lib/supabase/service-client";
import { DBTables } from "@/lib/enums/Tables";

export async function sendAutoReply(to: string) {
  // message like we are not replying to messages from this number due to automatic system for any supoort contact +918525095422
  const replyText =
    "Thank you for contacting SB Solar Shop!\n" +
    "This is an automated response — this number is not monitored for support or inquiries.\n" +
    "For any assistance, please WhatsApp us directly at +91 85250 95422.\n" +
    "We appreciate your interest and look forward to assisting you!";
  // WhatsApp API call
  const WHATSAPP_API_URL = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_API_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: replyText },
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  };
  const res = await fetch(WHATSAPP_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const responseStatus = await res.status;
    const response = await res.text();
    throw new Error(responseStatus + response);
  }
  const response = await res.json();
  const wamId = response.messages?.[0]?.id || `auto-reply-${Date.now()}`;
  // Store in DB after successful send
  const supabase = createServiceClient();
  await supabase.from(DBTables.Messages).insert({
    chat_id: to,
    message: { text: { body: replyText }, type: "text", to },
    wam_id: wamId,
    created_at: new Date(),
    is_received: false,
  });
}
