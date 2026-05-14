async function getTelegramApiApp({
  supabase
}) {
  const { data, error } = await supabase
    .from("tg_api_apps")
    .select("*")
    .eq("active", true)
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error("No Telegram API apps");
  }

  return data;
}

module.exports = {
  getTelegramApiApp
};