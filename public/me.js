const TOKEN_KEY = "cf_notify_user_jwt";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  userId: null,
  email: null,
  bindings: [],
  subscriptions: [],
  logs: [],
  pollTimer: null,
  currentCode: null,
  currentChannel: "wechat_oa"
};

const CHANNELS = {
  wechat_oa: {
    eyebrow: "WeChat",
    heading: "公众号通知绑定",
    account: "微信账号",
    emptyTitle: "尚未绑定公众号",
    emptySub: "绑定后，业务系统可将通知送达您的微信。",
    readyTitle: "公众号通知已就绪",
    readySub: "系统可通过公众号向您推送任务结果与重要提醒。",
    openStep: "使用微信扫描 / 关注公众号。",
    sendStep: "将绑定码原样发送给公众号，等待本页状态变为「已绑定」。",
    destination: "公众号"
  },
  wecom: {
    eyebrow: "WeCom",
    heading: "企业微信通知绑定",
    account: "企业微信账号",
    emptyTitle: "尚未绑定企业微信",
    emptySub: "绑定后，业务系统可通过企业微信应用向您推送通知。",
    readyTitle: "企业微信通知已就绪",
    readySub: "系统可通过企业微信应用向您推送任务结果与重要提醒。",
    openStep: "打开企业微信中的通知应用。",
    sendStep: "将绑定码原样发送给应用，等待本页状态变为「已绑定」。",
    destination: "企业微信应用"
  }
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

function parseJwt(token) {
  try {
    const p = token.split(".")[1];
    const json = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function setToken(token) {
  state.token = token || "";
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      setToken("");
      showGate();
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function showGate() {
  $("gate").hidden = false;
  $("portal").hidden = true;
  stopPoll();
}

function showPortal() {
  $("gate").hidden = true;
  $("portal").hidden = false;
  const label = state.email || state.userId || "已登录";
  $("user-label").textContent = label;
}

function stopPoll() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function renderBindings() {
  const config = CHANNELS[state.currentChannel];
  const binding = state.bindings.find(
    (item) => item.channel === state.currentChannel && item.status === "verified"
  );
  $("bind-eyebrow").textContent = config.eyebrow;
  $("bind-heading").textContent = config.heading;
  $("bound-account-title").textContent = config.account;
  $("bind-step-open").textContent = config.openStep;
  $("bind-step-send").textContent = config.sendStep;
  document.querySelectorAll("[data-bind-channel]").forEach((button) => {
    button.classList.toggle("active", button.dataset.bindChannel === state.currentChannel);
  });
  if (binding) {
    $("bind-badge").textContent = "已绑定";
    $("bind-badge").className = "badge badge-ok";
    $("bind-hero-title").textContent = config.readyTitle;
    $("bind-hero-sub").textContent = config.readySub;
    $("bound-panel").hidden = false;
    $("bind-flow").hidden = true;
    $("bound-openid").textContent = binding.maskedLabel || "已验证";
    $("bound-time").textContent = binding.verifiedAt
      ? `绑定时间 ${new Date(binding.verifiedAt).toLocaleString("zh-CN")}`
      : "";
  } else {
    $("bind-badge").textContent = "未绑定";
    $("bind-badge").className = "badge badge-muted";
    $("bind-hero-title").textContent = config.emptyTitle;
    $("bind-hero-sub").textContent = config.emptySub;
    $("bound-panel").hidden = true;
    $("bind-flow").hidden = false;
  }
}

function renderSubs() {
  const list = $("sub-list");
  if (!state.subscriptions.length) {
    list.innerHTML = `<div class="empty">暂无订阅，当前不会接收业务通知。</div>`;
    return;
  }
  list.innerHTML = state.subscriptions
    .map(
      (s) => `
    <article class="item">
      <div class="item-row">
        <p class="item-title">${escapeHtml(s.serviceId)} · ${escapeHtml(s.eventType)}</p>
        <span class="badge ${s.enabled ? "badge-ok" : "badge-muted"}">${s.enabled ? "启用" : "关闭"}</span>
      </div>
      <div class="item-meta">通道 ${(s.channels || []).join(", ") || "—"}</div>
      <div class="row-actions">
        <button type="button" class="btn btn-danger btn-sm" data-del-sub="${escapeHtml(s.id)}">删除</button>
      </div>
    </article>`
    )
    .join("");
}

function renderLogs() {
  const list = $("log-list");
  if (!state.logs.length) {
    list.innerHTML = `<div class="empty">暂无投递记录</div>`;
    return;
  }
  list.innerHTML = state.logs
    .map((l) => {
      const badge =
        l.status === "sent"
          ? "badge-ok"
          : l.status === "failed"
            ? "badge-danger"
            : "badge-warn";
      return `
    <article class="item">
      <div class="item-row">
        <p class="item-title">${escapeHtml(l.eventType || "—")} · ${escapeHtml(l.channel || "—")}</p>
        <span class="badge ${badge}">${escapeHtml(l.status)}</span>
      </div>
      <div class="item-meta">
        <span>${l.createdAt ? new Date(l.createdAt).toLocaleString("zh-CN") : ""}</span>
        ${l.error ? `<span class="mono">${escapeHtml(l.error)}</span>` : ""}
      </div>
    </article>`;
    })
    .join("");
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function loadAll() {
  const [bindings, subs, logs] = await Promise.all([
    api("/api/bindings"),
    api("/api/subscriptions").catch(() => ({ subscriptions: [] })),
    api("/api/logs?limit=20")
  ]);
  state.bindings = bindings.bindings || [];
  state.subscriptions = subs.subscriptions || [];
  state.logs = logs.logs || [];
  renderBindings();
  renderSubs();
  renderLogs();
}

async function enterWithToken(token) {
  const payload = parseJwt(token);
  if (!payload?.sub) throw new Error("无效的 JWT");
  setToken(token);
  state.userId = payload.sub;
  state.email = payload.email || null;
  showPortal();
  await loadAll();
}

$("btn-enter").onclick = async () => {
  try {
    const token = $("jwt-input").value.trim().replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("请粘贴 JWT");
    await enterWithToken(token);
    toast("已进入通知中心", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-test-token").onclick = async () => {
  try {
    const res = await fetch("/api/test/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "无法生成测试 Token（需 ALLOW_TEST_TOKEN）");
    $("jwt-input").value = data.token;
    toast("测试 Token 已填入", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-logout").onclick = () => {
  setToken("");
  showGate();
  toast("已退出");
};

$("btn-refresh").onclick = () => loadAll().then(() => toast("已刷新", "ok")).catch((e) => toast(e.message, "err"));

document.querySelectorAll("[data-bind-channel]").forEach((button) => {
  button.onclick = () => {
    stopPoll();
    state.currentChannel = button.dataset.bindChannel;
    state.currentCode = null;
    $("bind-code").textContent = "······";
    $("bind-hint").textContent = "点击生成后显示";
    $("bind-status").textContent = "";
    $("btn-copy-code").disabled = true;
    renderBindings();
  };
});

$("btn-gen-code").onclick = async () => {
  try {
    stopPoll();
    const data = await api("/api/bindings/code", {
      method: "POST",
      body: JSON.stringify({ channel: state.currentChannel })
    });
    state.currentCode = data.code;
    $("bind-code").textContent = data.code;
    $("bind-hint").textContent = data.hint
      || `请在 ${data.expireIn || 300}s 内发送给${CHANNELS[state.currentChannel].destination}`;
    $("btn-copy-code").disabled = false;
    $("bind-status").textContent = "等待公众号确认…";
    state.pollTimer = setInterval(async () => {
      try {
        const st = await api(`/api/bindings/status?code=${encodeURIComponent(data.code)}`);
        $("bind-status").textContent = `状态：${st.status}`;
        if (st.status === "verified") {
          stopPoll();
          toast("绑定成功", "ok");
          await loadAll();
        }
      } catch (e) {
        $("bind-status").textContent = e.message;
      }
    }, 2000);
  } catch (e) {
    toast(e.message, "err");
  }
};

$("btn-copy-code").onclick = async () => {
  if (!state.currentCode) return;
  try {
    await navigator.clipboard.writeText(state.currentCode);
    toast("已复制绑定码", "ok");
  } catch {
    toast("复制失败，请手动选择", "err");
  }
};

$("btn-unbind").onclick = async () => {
  const binding = state.bindings.find(
    (item) => item.channel === state.currentChannel && item.status === "verified"
  );
  if (!binding) return;
  const config = CHANNELS[state.currentChannel];
  if (!confirm(`确定解除${config.heading.replace("通知绑定", "")}绑定？`)) return;
  try {
    await api(`/api/bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
    toast("已解绑", "ok");
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
  }
};

$("sub-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        serviceId: $("sub-service").value.trim(),
        eventType: $("sub-event").value.trim(),
        channels: ["wechat_oa"],
        enabled: true
      })
    });
    toast("订阅已保存", "ok");
    await loadAll();
  } catch (err) {
    toast(err.message, "err");
  }
};

$("sub-list").onclick = async (e) => {
  const btn = e.target.closest("[data-del-sub]");
  if (!btn) return;
  try {
    await api(`/api/subscriptions/${encodeURIComponent(btn.dataset.delSub)}`, { method: "DELETE" });
    toast("已删除订阅", "ok");
    await loadAll();
  } catch (err) {
    toast(err.message, "err");
  }
};

$("btn-sub-refresh").onclick = () => loadAll().catch((e) => toast(e.message, "err"));
$("btn-logs-refresh").onclick = () => loadAll().catch((e) => toast(e.message, "err"));

// Show test token button if endpoint exists
fetch("/api/test/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  .then((r) => {
    if (r.status !== 404) $("btn-test-token").hidden = false;
  })
  .catch(() => {});

if (state.token) {
  enterWithToken(state.token).catch(() => {
    setToken("");
    showGate();
  });
} else {
  showGate();
}
