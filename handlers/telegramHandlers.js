function registerTelegramHandlers({
  bot,
  supabase,
  deletingWaPhones,
  isAdmin,
  ADMIN_ID,
  clientWaState,
  waitingForDelete,
  deleteAccountFromSystem,
  markTelegramActiveByUsername,
  makeToken,
  getWaSheetIntervalMs,
  setWaSheetIntervalMs,
  startWaSheetAutoImportInterval,
  appendSheetRow,
  readAccountsFromSheet,
  updateSheetRow,
  readTelegramFromSheet,
  updateTelegramSheetRow,
  markSheetBanAndReport,
  waitingForTelegramAdd,
  tgUsers,
  getAccountsStatusText,

  startWhatsApp,
  startWaChecker,
  checkWhatsAppLastSeenFromSheet,
  activeSessions,
  scheduleSessionUpload,
  saveStatus
}) {
  console.log("Telegram handlers registered");
  const waitingForWaWebLogin = new Set();
  bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    console.log("START received", msg.from.id);

    const startPayload =
      match && match[1]
        ? match[1].trim()
        : null;

    if (startPayload && startPayload.startsWith("wa_")) {
      const token = startPayload.replace("wa_", "");

      const { data: link } = await supabase
        .from("wa_connect_links")
        .select("*")
        .eq("token", token)
        .eq("active", true)
        .single();

      if (!link) {
        await bot.sendMessage(
          msg.chat.id,
          "❌ Ссылка недействительна или отключена."
        );
        return;
      }

      await supabase
        .from("wa_connect_links")
        .update({
          clicks: (link.clicks || 0) + 1
        })
        .eq("id", link.id);

      clientWaState.set(msg.from.id, {
        step: "ready",
        token
      });

      await bot.sendMessage(
        msg.chat.id,
        `👋 Подключение WhatsApp

Нажми кнопку ниже, чтобы подключить WhatsApp.`,
        {
          reply_markup: {
            keyboard: [
              ["➕ Подключить WhatsApp"]
            ],
            resize_keyboard: true
          }
        }
      );

      return;
    }

    if (startPayload && startPayload.startsWith("admin_")) {
      const token = startPayload.replace("admin_", "");

      const { data: link } = await supabase
        .from("admin_links")
        .select("*")
        .eq("token", token)
        .eq("active", true)
        .single();

      if (!link) {
        await bot.sendMessage(
          msg.chat.id,
          "❌ Ссылка доступа недействительна."
        );
        return;
      }

      await supabase
        .from("bot_admins")
        .upsert({
          user_id: String(msg.from.id),
          username: msg.from.username || null,
          first_name: msg.from.first_name || null
        }, {
          onConflict: "user_id"
        });

      await supabase
        .from("admin_links")
        .update({
          clicks: (link.clicks || 0) + 1
        })
        .eq("id", link.id);

      await bot.sendMessage(
        msg.chat.id,
        `✅ Доступ к админке выдан.

Напиши /start ещё раз.`
      );

      return;
    }

    if (!(await isAdmin({
      userId: msg.from.id,
      adminId: ADMIN_ID,
      supabase
    }))) {
      return;
    }

    await sendAdminMenu(msg.chat.id);
  });

  bot.on("message", async (msg) => {
    const chat = msg.chat;
    const user = msg.from;
    const text = msg.text;

    if (!chat) return;
    if (!user) return;

    if (
      (chat.type === "group" || chat.type === "supergroup") &&
      msg.new_chat_members &&
      msg.new_chat_members.length
    ) {
      for (const newUser of msg.new_chat_members) {
        await markTelegramActiveByUsername(newUser.username);
      }

      await bot.sendMessage(
        chat.id,
        `👋 Добро пожаловать.

Нажми кнопку ниже, чтобы пройти проверку.`,
        {
          reply_markup: {
            keyboard: [
              ["➕ Провериться"]
            ],
            resize_keyboard: true
          }
        }
      );

      return;
    }

    if (chat.type === "group" || chat.type === "supergroup") {
      await markTelegramActiveByUsername(user.username);

      if (text === "➕ Провериться") {
        await bot.sendMessage(
          chat.id,
          `➕ ${user.first_name || "User"}`
        );
      }

      return;
    }

    if (!text) return;
    if (text === "/start") return;

    if (text === "➕ Подключить WhatsApp") {
      const state = clientWaState.get(user.id);

      if (!state || !state.token) {
        await bot.sendMessage(
          chat.id,
          "❌ Ссылка подключения не найдена. Открой ссылку заново."
        );
        return;
      }

      const { data: link } = await supabase
        .from("wa_connect_links")
        .select("*")
        .eq("token", state.token)
        .eq("active", true)
        .single();

      if (!link) {
        await bot.sendMessage(
          chat.id,
          "❌ Ссылка недействительна или отключена."
        );
        return;
      }

      await bot.sendMessage(
        chat.id,
        "📱 Отправь номер WhatsApp в формате 380991112233"
      );

      clientWaState.set(user.id, {
        step: "wait_phone",
        token: state.token
      });

      return;
    }

    const waState = clientWaState.get(user.id);

    if (waState && waState.step === "wait_phone") {
      const phone = String(text).replace(/[^\d]/g, "");

      if (!phone || phone.length < 8) {
        await bot.sendMessage(
          chat.id,
          "❌ Неверный номер. Отправь номер цифрами."
        );
        return;
      }

      clientWaState.delete(user.id);

      await bot.sendMessage(
        chat.id,
        `⏳ Запускаю WhatsApp ${phone}, жди QR...`
      );

      await startWhatsApp({
        phone,
        chatId: chat.id,
        bot,
        supabase,
        SESSION_SECRET: process.env.SESSION_SECRET,
        SESSION_BUCKET: "wa-sessions",
        activeSessions,
        deletingWaPhones,
        scheduleSessionUpload,
        saveStatus,
        markSheetBanAndReport
      });

      return;
    }

    if (!(await isAdmin({
      userId: user.id,
      adminId: ADMIN_ID,
      supabase
    }))) {
      return;
    }

    if (text === "🔐 WA Web Login") {
  waitingForWaWebLogin.add(user.id);

  await bot.sendMessage(
    chat.id,
    "📱 Отправь номер WhatsApp для WA Web авторизации\n\nПример:\n380998338356"
  );

  return;
}

if (waitingForWaWebLogin.has(user.id)) {
  waitingForWaWebLogin.delete(user.id);

  const phone =
    String(text).replace(/[^\d]/g, "");

  if (!phone || phone.length < 8) {
    await bot.sendMessage(
      chat.id,
      "❌ Неверный номер."
    );

    return;
  }

  try {
    await bot.sendMessage(
      chat.id,
      "⏳ Получаю код авторизации..."
    );

    const response =
      await fetch(
        `${process.env.WA_WEB_CHECKER_URL}/login-code?phone=${phone}`
      );

    const data =
      await response.json();

    if (!data.ok) {
      await bot.sendMessage(
        chat.id,
        `❌ Ошибка:\n${data.error || "Unknown"}`
      );

      return;
    }

    if (data.authorized) {
      await bot.sendMessage(
        chat.id,
        "✅ WA Web уже авторизован."
      );

      return;
    }

    await bot.sendMessage(
      chat.id,
      `🔑 Код WA Web:\n\n${data.code}\n\nWhatsApp → Связанные устройства → Связать по номеру телефона`
    );

  } catch (err) {
    console.log(
      "WA WEB LOGIN ERROR:",
      err.message
    );

    await bot.sendMessage(
      chat.id,
      `❌ Ошибка:\n${err.message}`
    );
  }

  return;
}

    if (text === "🟢 WA Проверяльщик") {
      await bot.sendMessage(
        chat.id,
        "⏳ Запускаю WA Проверяльщик."
      );

      await startWaChecker({
        phone: "380998338356",
        chatId: chat.id,
        bot,
        supabase,
        SESSION_SECRET: process.env.SESSION_SECRET,
        SESSION_BUCKET: "wa-sessions",
        scheduleSessionUpload
      });

      return;
    }

    if (text === "🔍 Проверить WA из таблицы") {
      console.log("WA SHEET CHECK BUTTON PRESSED");

      await checkWhatsAppLastSeenFromSheet({
        bot,
        chatId: chat.id
      });

      return;
    }

    if (text === "🗑 Удалить") {
      waitingForDelete.add(user.id);

      await bot.sendMessage(
        chat.id,
        `Отправь номер WhatsApp или Telegram username.

Пример:
380991112233

или:
@username`
      );

      return;
    }

    if (waitingForDelete.has(user.id)) {
      waitingForDelete.delete(user.id);

      await deleteAccountFromSystem(
        text,
        chat.id
      );

      return;
    }

    if (text === "⏱ Интервал") {
      await bot.sendMessage(
        chat.id,
        `Выбери интервал проверки:`,
        {
          reply_markup: {
            keyboard: [
              ["15 минут"],
              ["30 минут"],
              ["1 час"],
              ["3 часа"],
              ["Назад"]
            ],
            resize_keyboard: true
          }
        }
      );

      return;
    }

    if (
      text === "15 минут" ||
      text === "30 минут" ||
      text === "1 час" ||
      text === "3 часа"
    ) {
      if (text === "15 минут") {
        setWaSheetIntervalMs(15 * 60 * 1000);
      }

      if (text === "30 минут") {
        setWaSheetIntervalMs(30 * 60 * 1000);
      }

      if (text === "1 час") {
        setWaSheetIntervalMs(60 * 60 * 1000);
      }

      if (text === "3 часа") {
        setWaSheetIntervalMs(3 * 60 * 60 * 1000);
      }

      startWaSheetAutoImportInterval();

      await bot.sendMessage(
        chat.id,
        `✅ Интервал установлен: ${text}`
      );

      return;
    }

    if (text === "Назад") {
      await sendAdminMenu(chat.id);
      return;
    }

    if (text === "🔵 Telegram") {
      try {
        const invite = await bot.createChatInviteLink(
          process.env.CHECKER_GROUP_ID,
          {
            member_limit: 0,
            creates_join_request: false
          }
        );

        await bot.sendMessage(
          chat.id,
          `🔵 Ссылка для подключения Telegram:

${invite.invite_link}

Отправь её человеку.
После входа в группу и нажатия ➕ Провериться аккаунт активируется автоматически.`
        );
      } catch (err) {
        console.log(
          "Telegram invite error:",
          err.message
        );

        await bot.sendMessage(
          chat.id,
          `❌ Ошибка создания ссылки: ${err.message}`
        );
      }

      return;
    }

    if (text === "🔗 WhatsApp") {
      const token = makeToken();

      await supabase
        .from("wa_connect_links")
        .insert({
          token,
          created_by: String(user.id),
          active: true
        });

      const me = await bot.getMe();

      await bot.sendMessage(
        chat.id,
        `🔗 Ссылка для подключения WhatsApp:

https://t.me/${me.username}?start=wa_${token}`
      );

      return;
    }

    if (text === "🔐 Доступ") {
      const token = makeToken();

      await supabase
        .from("admin_links")
        .insert({
          token,
          created_by: String(user.id),
          active: true
        });

      const me = await bot.getMe();

      await bot.sendMessage(
        chat.id,
        `🔐 Ссылка доступа:

https://t.me/${me.username}?start=admin_${token}`
      );

      return;
    }

    if (text === "📊 Статус") {
      try {
        const statusText = await getAccountsStatusText();

        await bot.sendMessage(
          chat.id,
          statusText,
          {
            parse_mode: "HTML"
          }
        );
      } catch (err) {
        console.log("Status button error:", err);

        await bot.sendMessage(
          chat.id,
          `❌ Ошибка статуса: ${err.message}`
        );
      }

      return;
    }
  });

  async function sendAdminMenu(chatId) {
    await bot.sendMessage(
      chatId,
      `👋 WA Checker готов`,
      {
        reply_markup: {
          keyboard: [
            [
              "📊 Статус",
              "🗑 Удалить"
            ],
            [
              "🟢 WA Проверяльщик",
              "🔐 WA Web Login"
            ],
            [
              "🔍 Проверить WA из таблицы"
            ],
            [
              "🔗 WhatsApp",
              "🔵 Telegram"
            ],
            [
              "🔐 Доступ"
            ],
            [
              "⏱ Интервал"
            ]
          ],
          resize_keyboard: true
        }
      }
    );
  }
}

module.exports = {
  registerTelegramHandlers
};
