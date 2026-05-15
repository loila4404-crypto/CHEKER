async function autoLoadSessions({
  supabase,
  REPORT_CHAT_ID,
  startWhatsApp,
  bot,
  SESSION_SECRET,
  SESSION_BUCKET,
  activeSessions,
  deletingWaPhones,
  scheduleSessionUpload,
  saveStatus,
  markSheetBanAndReport,
  WORKER_ID
}) {
  const { data, error } =
    await supabase
      .from("wa_accounts")
      .select("*")
      .eq("worker_id", WORKER_ID);

  if (error) {
    console.log("Auto load error", error);
    return;
  }

  if (!data || !data.length) {
    console.log("No sessions to autoload");
    return;
  }

  console.log(
    `Autoloading ${data.length} sessions`
  );

  for (const acc of data) {
    try {
      console.log(`Starting ${acc.phone}`);

      startWhatsApp({
        phone: acc.phone,
        chatId: REPORT_CHAT_ID,
        bot,
        supabase,
        SESSION_SECRET,
        SESSION_BUCKET,
        activeSessions,
        deletingWaPhones,
        scheduleSessionUpload,
        saveStatus,
        markSheetBanAndReport
      });

      await new Promise(resolve =>
        setTimeout(resolve, 5000)
      );

    } catch (e) {
      console.log(
        `Autoload failed ${acc.phone}`,
        e
      );
    }
  }
}

module.exports = {
  autoLoadSessions
};
