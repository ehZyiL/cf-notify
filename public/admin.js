const state = {
  user: null,
  clients: [],
  logs: [],
  guides: []
};

const $ = (id) => document.getElementById(id);

function toast(msg, type = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type}`.trim();
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function adminApi(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(options.method || "GET")) {
    headers["X-CSRF-Protection"] = "same-origin";
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      window.location.assign(`/api/admin/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function showGate(message = "请使用 cf-auth 平台管理员账号登录。") {
  $("gate").hidden = false;
  $("shell").hidden = true;
  $("login-status").textContent = message;
}

function showShell() {
  $("gate").hidden = true;
  $("shell").hidden = false;
}

function switchPage(name) {
  document.querySelectorAll(".nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === name);
  });
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("active", p.id === `page-${name}`);
  });
  const titles = {
    overview: "总览",
    clients: "服务凭证",
    guides: "渠道引导",
    templates: "模板映射",
    logs: "投递日志"
  };
  $("page-title").textContent = titles[name] || name;
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function currentGuide() {
  return state.guides.find((guide) => guide.channel === $("guide-channel").value) || null;
}

function renderGuidePreview() {
  const imageUrl = safeHttpsUrl($("guide-image-url").value);
  const actionUrl = safeHttpsUrl($("guide-action-url").value);
  const accountName = $("guide-account-name").value.trim();
  const displayName = $("guide-display-name").value.trim() || "通知渠道";
  const description = $("guide-description").value.trim();
  const actionLabel = $("guide-action-label").value.trim() || "打开入口";
  $("guide-preview").innerHTML = `
    ${imageUrl ? `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayName)}二维码"></a>` : `<div class="guide-preview-empty">未配置二维码链接</div>`}
    <div class="guide-preview-copy">
      <strong>${escapeHtml(accountName || displayName)}</strong>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      ${actionUrl ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(actionLabel)}</a>` : ""}
    </div>`;
}

function renderGuideForm() {
  const guide = currentGuide();
  if (!guide) return;
  $("guide-enabled").checked = Boolean(guide.enabled);
  $("guide-display-name").value = guide.displayName || "";
  $("guide-account-name").value = guide.accountName || "";
  $("guide-description").value = guide.description || "";
  $("guide-image-url").value = guide.imageUrl || "";
  $("guide-action-url").value = guide.actionUrl || "";
  $("guide-action-label").value = guide.actionLabel || "";
  $("guide-source").textContent = guide.source === "kv" ? "动态配置" : "环境默认";
  $("guide-source").className = `badge ${guide.source === "kv" ? "badge-ok" : "badge-muted"}`;
  renderGuidePreview();
}

function renderClients() {
  const tb = $("clients-tbody");
  if (!state.clients.length) {
    tb.innerHTML = `<tr><td colspan="7" class="muted">暂无凭证，请在左侧创建。</td></tr>`;
    return;
  }
  tb.innerHTML = state.clients
    .map(
      (c) => `<tr>
      <td class="mono">${escapeHtml(c.clientId)}</td>
      <td>${escapeHtml(c.serviceId)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td class="mono wrap">${escapeHtml((c.scopes || []).join(", ") || "—")}</td>
      <td>${c.expiresAt ? escapeHtml(new Date(c.expiresAt).toLocaleString("zh-CN")) : "长期"}</td>
      <td><span class="badge ${c.enabled ? "badge-ok" : "badge-muted"}">${c.enabled ? "启用" : "停用"}</span></td>
      <td>${c.enabled ? `<button type="button" class="btn btn-danger btn-sm" data-revoke-client="${escapeHtml(c.clientId)}">撤销</button>` : "—"}</td>
    </tr>`
    )
    .join("");
  $("stat-clients").textContent = String(state.clients.length);
}

function renderLogs() {
  const tb = $("logs-tbody");
  if (!state.logs.length) {
    tb.innerHTML = `<tr><td colspan="7" class="muted">暂无日志</td></tr>`;
    return;
  }
  tb.innerHTML = state.logs
    .map((l) => {
      const badge =
        l.status === "sent" ? "badge-ok" : l.status === "failed" ? "badge-danger" : "badge-warn";
      return `<tr>
        <td>${l.createdAt ? escapeHtml(new Date(l.createdAt).toLocaleString("zh-CN")) : "—"}</td>
        <td class="mono">${escapeHtml(l.userId || "—")}</td>
        <td>${escapeHtml(l.serviceId || "—")}</td>
        <td>${escapeHtml(l.eventType || "—")}</td>
        <td>${escapeHtml(l.channel || "—")}</td>
        <td><span class="badge ${badge}">${escapeHtml(l.status)}</span></td>
        <td class="wrap mono">${escapeHtml(l.error || "")}</td>
      </tr>`;
    })
    .join("");
  $("stat-logs").textContent = String(state.logs.length);
  $("stat-failed").textContent = String(state.logs.filter((l) => l.status === "failed").length);
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ok) {
      $("health-badge").textContent = "Healthy";
      $("health-badge").className = "badge badge-ok";
      $("health-detail").textContent = `cf-notify · ${data.time || ""}`;
    } else {
      throw new Error("unhealthy");
    }
  } catch {
    $("health-badge").textContent = "Down";
    $("health-badge").className = "badge badge-danger";
    $("health-detail").textContent = "无法获取健康状态";
  }
}

async function loadData() {
  const [clients, logs, guides] = await Promise.all([
    adminApi("/api/admin/clients"),
    adminApi("/api/admin/logs?limit=50"),
    adminApi("/api/admin/channel-guides")
  ]);
  state.clients = clients.clients || [];
  state.logs = logs.logs || [];
  state.guides = guides.guides || [];
  renderClients();
  renderLogs();
  renderGuideForm();
  await loadHealth();
}

$("btn-admin-enter").onclick = () => {
  window.location.assign(`/api/admin/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
};

$("btn-admin-logout").onclick = async () => {
  await fetch("/api/admin/session", {
    method: "DELETE",
    headers: { "X-CSRF-Protection": "same-origin" }
  });
  state.user = null;
  showGate("已退出 cf-notify 控制台。cf-auth 的登录状态未受影响。");
};

$("btn-admin-refresh").onclick = () =>
  loadData().then(() => toast("已刷新", "ok")).catch((e) => toast(e.message, "err"));

document.querySelectorAll(".nav button").forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

$("guide-channel").onchange = renderGuideForm;
$("guide-form").addEventListener("input", renderGuidePreview);
$("guide-form").onsubmit = async (event) => {
  event.preventDefault();
  const channel = $("guide-channel").value;
  try {
    const data = await adminApi(`/api/admin/channel-guides/${encodeURIComponent(channel)}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("guide-enabled").checked,
        displayName: $("guide-display-name").value,
        accountName: $("guide-account-name").value,
        description: $("guide-description").value,
        imageUrl: $("guide-image-url").value,
        actionUrl: $("guide-action-url").value,
        actionLabel: $("guide-action-label").value
      })
    });
    state.guides = state.guides.map((guide) => guide.channel === channel ? data.guide : guide);
    renderGuideForm();
    toast("渠道引导已保存", "ok");
  } catch (error) {
    toast(error.message, "err");
  }
};

$("guide-reset").onclick = async () => {
  const channel = $("guide-channel").value;
  if (!confirm("恢复此渠道的环境默认配置？")) return;
  try {
    const data = await adminApi(`/api/admin/channel-guides/${encodeURIComponent(channel)}`, {
      method: "DELETE"
    });
    state.guides = state.guides.map((guide) => guide.channel === channel ? data.guide : guide);
    renderGuideForm();
    toast("已恢复环境默认", "ok");
  } catch (error) {
    toast(error.message, "err");
  }
};

$("client-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = {
      serviceId: $("client-service").value.trim(),
      name: $("client-name").value.trim() || undefined,
      scopes: [
        $("client-scope-send").checked ? "notifications.send" : null,
        $("client-scope-read").checked ? "notifications.delivery.read" : null
      ].filter(Boolean),
      expiresAt: $("client-expires").value
        ? new Date($("client-expires").value).toISOString()
        : undefined
    };
    const id = $("client-id").value.trim();
    if (id) body.clientId = id;
    const data = await adminApi("/api/admin/clients", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const box = $("client-secret-box");
    box.hidden = false;
    box.innerHTML = `请立即保存（只显示一次）<br>client_id=<strong>${escapeHtml(data.client.clientId)}</strong><br>client_secret=<strong>${escapeHtml(data.client.clientSecret)}</strong>`;
    e.target.reset();
    await loadData();
    toast("凭证已创建", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
};

$("clients-tbody").onclick = async (event) => {
  const button = event.target.closest("[data-revoke-client]");
  if (!button) return;
  if (!confirm(`确定撤销凭证 ${button.dataset.revokeClient}？`)) return;
  try {
    await adminApi(`/api/admin/clients/${encodeURIComponent(button.dataset.revokeClient)}`, {
      method: "DELETE"
    });
    await loadData();
    toast("凭证已撤销", "ok");
  } catch (error) {
    toast(error.message, "err");
  }
};

$("tpl-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    let map;
    try {
      map = JSON.parse($("tpl-map").value);
    } catch {
      throw new Error("template_map 不是合法 JSON");
    }
    await adminApi("/api/admin/channel-apps", {
      method: "POST",
      body: JSON.stringify({
        channel: $("tpl-channel").value.trim(),
        name: $("tpl-name").value.trim(),
        appId: $("tpl-appid").value.trim() || undefined,
        templateMap: map
      })
    });
    toast("模板映射已保存", "ok");
  } catch (err) {
    toast(err.message, "err");
  }
};

$("btn-logs-load").onclick = async () => {
  try {
    const userId = $("logs-user-filter").value.trim();
    const q = userId ? `?userId=${encodeURIComponent(userId)}&limit=80` : "?limit=80";
    const data = await adminApi(`/api/admin/logs${q}`);
    state.logs = data.logs || [];
    renderLogs();
    toast("日志已更新", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-retry").onclick = async () => {
  try {
    const data = await adminApi("/api/admin/retry", { method: "POST", body: "{}" });
    $("retry-result").textContent = JSON.stringify(data.results || data, null, 2);
    await loadData();
    toast("已触发重试", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};

async function boot() {
  const response = await fetch("/api/admin/session", {
    headers: { Accept: "application/json" }
  });
  if (response.status === 401) {
    window.location.assign(`/api/admin/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    showGate(data.error || "无法验证管理员身份。");
    return;
  }
  state.user = data.user || null;
  showShell();
  await loadData();
}

showGate("正在检查 cf-auth 登录状态…");
boot().catch((error) => showGate(error.message || "无法加载控制台。"));
