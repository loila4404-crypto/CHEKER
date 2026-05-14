async function isAdmin({
  userId,
  adminId,
  supabase
}) {
  if (String(userId) === String(adminId)) {
    return true;
  }

  const { data } = await supabase
    .from("bot_admins")
    .select("user_id")
    .eq("user_id", String(userId))
    .single();

  return !!data;
}

module.exports = {
  isAdmin
};