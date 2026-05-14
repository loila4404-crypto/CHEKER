async function getProxyForPhone({
  phone,
  supabase
}) {
  const { data: account } = await supabase
    .from("wa_accounts")
    .select("proxy_id")
    .eq("phone", phone)
    .single();

  if (account?.proxy_id) {
    const { data: proxy } = await supabase
      .from("proxies")
      .select("*")
      .eq("id", account.proxy_id)
      .eq("active", true)
      .single();

    return proxy || null;
  }

  const { data: proxies, error } = await supabase
    .from("proxies")
    .select("*")
    .eq("active", true);

  if (error || !proxies || !proxies.length) {
    return null;
  }

  const { data: usedAccounts } = await supabase
    .from("wa_accounts")
    .select("proxy_id")
    .not("proxy_id", "is", null);

  const usedProxyIds = new Set(
    (usedAccounts || []).map(acc => acc.proxy_id)
  );

  const freeProxy =
    proxies.find(proxy => !usedProxyIds.has(proxy.id)) || proxies[0];

  await supabase
    .from("wa_accounts")
    .update({ proxy_id: freeProxy.id })
    .eq("phone", phone);

  return freeProxy;
}

module.exports = {
  getProxyForPhone
};