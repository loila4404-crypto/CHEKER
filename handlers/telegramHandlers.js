function registerTelegramHandlers({
  bot,
  supabase,
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
  tgUsers
}) {
  bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const startPayload =
      match && match[1]
        ? match[1].trim()
        : null;

    if (
      startPayload &&
      startPayload.startsWith("wa_")
    ) {
      const token =
        startPayload.replace("wa_", "");

      const { data: link } =
        await supabase
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

    if (
      startPayload &&
      startPayload.startsWith("admin_")
    ) {
      const token =
        startPayload.replace("admin_", "");

      const { data: link } =
        await supabase
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

    await bot.sendMessage(
      msg.chat.id,
      `👋 WA Checker готов`,
      {
        reply_markup: {
          keyboard: [
            [
              "📊 Статус",
              "🗑 Удалить"
            ],
            [
              "🔗 WhatsApp",
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
        await markTelegramActiveByUsername(
          newUser.username
        );
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

    if (
      chat.type === "group" ||
      chat.type === "supergroup"
    ) {
      await markTelegramActiveByUsername(
        user.username
      );

      if (text === "➕ Провериться") {
        await bot.sendMessage(
          chat.id,
          `➕ ${user.first_name || "User"}`
        );
      }

      return;
    }

    if (!(await isAdmin({
      userId: user.id,
      adminId: ADMIN_ID,
      supabase
    }))) {
      return;
    }

    if (!text) return;
    if (text === "/start") return;

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
      await bot.sendMessage(
        chat.id,
        `👋 WA Checker готов`,
        {
          reply_markup: {
            keyboard: [
              [
                "📊 Статус",
                "🗑 Удалить"
              ],
              [
                "🔗 WhatsApp",
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
      bot.processUpdate({
        message: {
          ...msg,
          text: "/status"
        }
      });

      return;
    }
  });

  bot.onText(/\/check_button/, async (msg) => {
    if (String(msg.from.id) !== String(ADMIN_ID)) return;

    await bot.sendMessage(
      msg.chat.id,
      `👥 Нажми кнопку ниже, чтобы бот сохранил твой Telegram ID для проверки.`,
      {
        reply_markup: {
          keyboard: [
            [
              {
                text: "➕ Провериться"
              }
            ]
          ],
          resize_keyboard: true,
          persistent_keyboard: true
        }
      }
    );
  });

  bot.on("callback_query", async (query) => {
    const data = query.data;
    const user = query.from;
    const msg = query.message;

    if (data !== "tg_check_me") return;

    await supabase
      .from("tg_group_users")
      .upsert({
        chat_id: String(msg.chat.id),
        user_id: String(user.id),
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        is_bot: user.is_bot || false,
        is_deleted:
          user.first_name === "Deleted Account" ||
          user.first_name === "Удалённый аккаунт",
        member_status: "button_clicked",
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: "chat_id,user_id"
      });

    await bot.answerCallbackQuery(query.id, {
      text: "✅ Ты добавлен в проверку"
    });

    await bot.sendMessage(
      msg.chat.id,
      `➕ ${user.first_name || "User"}`
    );
  });

  bot.onText(/\/sheet_import/, async (msg) => {
  if (!(await isAdmin({
    userId: msg.from.id,
    adminId: ADMIN_ID,
    supabase
  }))) return;

  try {
    const rows = await readAccountsFromSheet();

    if (!rows.length) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ В таблице нет аккаунтов."
      );

      return;
    }

    let activated = 0;
    let waiting = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 2;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const status = rows[i][3] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      if (type !== "WhatsApp") {
        skipped++;
        continue;
      }

      if (!account) {
        skipped++;
        continue;
      }

      if (status !== "CONNECTION") {
        skipped++;
        continue;
      }

      const phone = String(account).replace(/[^\d]/g, "");

      if (!phone || phone.length < 8) {
        await updateSheetRow(rowNumber, [
          id,
          type,
          account,
          "CONNECTION",
          adName,
          operator
        ]);

        skipped++;
        continue;
      }

      const { data: existing, error } = await supabase
        .from("wa_accounts")
        .select("*")
        .eq("phone", phone)
        .single();

      if (error || !existing) {
        waiting++;
        continue;
      }

      await updateSheetRow(rowNumber, [
        existing.id || id,
        "WhatsApp",
        phone,
        "ACTIVE",
        adName,
        operator
      ]);

      activated++;
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Импорт готов.

Активировано: ${activated}
Ожидают Supabase: ${waiting}
Пропущено: ${skipped}`
    );
  } catch (err) {
    console.log("Sheet import error:", err);

    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка импорта: ${err.message}`
    );
  }
});

bot.onText(/\/check_button/, async (msg) => {
  if (!(await isAdmin({
    userId: msg.from.id,
    adminId: ADMIN_ID,
    supabase
  }))) {
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `👥 Нажми кнопку ниже, чтобы бот сохранил твой Telegram ID для проверки.`,
    {
      reply_markup: {
        keyboard: [
          [
            {
              text: "➕ Провериться"
            }
          ]
        ],
        resize_keyboard: true,
        persistent_keyboard: true
      }
    }
  );
});

bot.onText(/\/sheet_sync/, async (msg) => {
  if (!(await isAdmin({
    userId: msg.from.id,
    adminId: ADMIN_ID,
    supabase
  }))) return;

  try {
    const { data, error } = await supabase
      .from("wa_accounts")
      .select("*")
      .order("created_at", {
        ascending: true
      });

    if (error) {
      throw error;
    }

    if (!data || !data.length) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ В Supabase пока нет WhatsApp аккаунтов."
      );

      return;
    }

    let synced = 0;

    for (const acc of data) {
      const status =
        acc.status === "logged_out" ||
        acc.status === "banned"
          ? "BAN"
          : "ACTIVE";

      await appendSheetRow([
        acc.id || "",
        "WhatsApp",
        acc.phone || "",
        status
      ]);

      synced++;
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Синхронизация готова. В таблицу добавлено: ${synced}`
    );
  } catch (err) {
    console.log("Sheet sync error:", err);

    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка синхронизации: ${err.message}`
    );
  }
});

bot.onText(/\/tg_sheet_import/, async (msg) => {
  if (!(await isAdmin({
    userId: msg.from.id,
    adminId: ADMIN_ID,
    supabase
  }))) return;

  try {
    const rows = await readTelegramFromSheet();

    if (!rows.length) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Telegram таблица пустая."
      );

      return;
    }

    let activated = 0;
    let waiting = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 3;

      const id = rows[i][0] || "";
      const type = rows[i][1] || "";
      const account = rows[i][2] || "";
      const status = rows[i][3] || "";
      const adName = rows[i][4] || "";
      const operator = rows[i][5] || "";

      if (type !== "Telegramm") {
        skipped++;
        continue;
      }

      if (!account) {
        skipped++;
        continue;
      }

      if (status !== "CONNECTION") {
        skipped++;
        continue;
      }

      const userId = String(account).replace(/[^\d]/g, "");

      const exists =
        tgUsers.has(userId);

      if (!exists) {
        waiting++;
        continue;
      }

      await updateTelegramSheetRow(rowNumber, [
        id,
        "Telegramm",
        userId,
        "ACTIVE",
        adName,
        operator
      ]);

      activated++;
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ Telegram импорт готов.

Активировано: ${activated}
Ожидают: ${waiting}
Пропущено: ${skipped}`
    );
  } catch (err) {
    console.log("tg_sheet_import error:", err);

    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка: ${err.message}`
    );
  }
});

bot.onText(/\/sheet_test/, async (msg) => {
  if (!(await isAdmin({
    userId: msg.from.id,
    adminId: ADMIN_ID,
    supabase
  }))) return;

  try {
    const rows = await readAccountsFromSheet();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Google Sheets подключен. Строк найдено: ${rows.length}`
    );
  } catch (err) {
    console.log("Sheet test error:", err);

    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка Google Sheets: ${err.message}`
    );
  }
});

}

module.exports = {
  registerTelegramHandlers
};