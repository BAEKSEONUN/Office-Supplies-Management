(() => {
  "use strict";

  const LANG_KEY = "osm.lang"; // per-browser UI preference only; items/movements live in the shared data file

  // ================= shared data file (File System Access API) =================
  // No backend server: every browser reads/writes the SAME JSON file located
  // on the office's always-on shared network folder. Everyone who connects
  // to that file sees everyone else's changes (refreshed by polling below).
  const FS_SUPPORTED = typeof window.showOpenFilePicker === "function";
  const IDB_NAME = "qlvpp-fs";
  const IDB_STORE = "handles";
  const IDB_KEY = "dataFileHandle";
  const POLL_INTERVAL_MS = 5000;

  let fileHandle = null;
  let lastSeenModified = 0;
  let pollTimer = null;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function ensureReadWritePermission(handle) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  }

  async function readDataFile() {
    const file = await fileHandle.getFile();
    lastSeenModified = file.lastModified;
    const text = await file.text();
    if (!text.trim()) return { items: [], movements: [] };
    try {
      const parsed = JSON.parse(text);
      return { items: parsed.items || [], movements: parsed.movements || [] };
    } catch {
      return { items: [], movements: [] };
    }
  }

  async function writeDataFile(data) {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    const file = await fileHandle.getFile();
    lastSeenModified = file.lastModified;
  }

  // The browser can grant "readwrite" permission on a handle while the
  // underlying OS/network share still blocks the actual write (e.g. the
  // shared folder or file is set to 읽기 전용/read-only for that person's
  // Windows account). That combination looks identical to a normal
  // successful connection — data loads fine — until they try to save
  // something. Catch it immediately after connecting instead, with a
  // harmless round-trip write, so the person gets a clear answer up front.
  async function testWriteAccess() {
    try {
      const data = await readDataFile();
      await writeDataFile(data);
      return true;
    } catch (err) {
      console.error("write test failed", err);
      return false;
    }
  }

  async function addItemsBulk(entries) {
    const data = await readDataFile();
    const created = entries.map((entry) => ({
      id: crypto.randomUUID(),
      name: entry.name,
      unit: entry.unit || "",
      note: entry.note || "",
      photo: entry.photo || "",
    }));
    data.items.push(...created);
    await writeDataFile(data);
    return created;
  }

  async function deleteItemOnDisk(id) {
    const data = await readDataFile();
    data.items = data.items.filter((it) => it.id !== id);
    await writeDataFile(data);
  }

  async function addMovementOnDisk(payload) {
    const data = await readDataFile();
    const movement = { id: crypto.randomUUID(), ...payload };
    data.movements.unshift(movement);
    await writeDataFile(data);
    return movement;
  }

  async function loadAllFromDisk() {
    const data = await readDataFile();
    state.items = data.items;
    state.movements = data.movements;
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!fileHandle) return;
      try {
        const file = await fileHandle.getFile();
        if (file.lastModified === lastSeenModified) return; // no external change
        await loadAllFromDisk();
        renderListItems();
        renderStockItems();
        if (!historyModalOverlay.hidden) renderHistoryTable();
      } catch (err) {
        console.error("poll failed", err);
      }
    }, POLL_INTERVAL_MS);
  }

  // ---------- connect-file UI ----------
  const connectModalOverlay = document.getElementById("connect-modal-overlay");
  const connectUnsupportedMsg = document.getElementById("connect-unsupported");
  const connectActions = document.getElementById("connect-actions");
  const connectOpenBtn = document.getElementById("connect-open-btn");
  const connectCreateBtn = document.getElementById("connect-create-btn");
  const fileStatusText = document.getElementById("file-status-text");
  const fileChangeBtn = document.getElementById("file-change-btn");

  // A handle restored from IndexedDB whose permission needs to be
  // re-confirmed. Browsers only allow that confirmation to happen inside a
  // real user gesture (click/tap), so instead of forcing a dedicated
  // "재연결" click, we quietly reuse the user's very next click anywhere in
  // the app to do it — see armAutoReconnect().
  let pendingSavedHandle = null;

  function updateFileStatusUI() {
    if (fileHandle) {
      const base = t("file_status_connected", { name: fileHandle.name });
      fileStatusText.textContent = state.readOnly ? `${base} ${t("file_status_readonly_suffix")}` : base;
    } else if (pendingSavedHandle) {
      fileStatusText.textContent = t("file_status_reconnecting");
    } else {
      fileStatusText.textContent = t("file_status_disconnected");
    }
    fileChangeBtn.hidden = !fileHandle;
  }

  function updateReadOnlyUI() {
    bulkSaveBtn.disabled = state.readOnly;
  }

  const reconnectSection = document.getElementById("reconnect-section");
  const reconnectBtn = document.getElementById("reconnect-btn");
  const reconnectPickOtherBtn = document.getElementById("reconnect-pick-other-btn");
  let pendingReconnectHandle = null;

  // pass a previously-saved handle to offer a one-click "재연결" instead of
  // making the user browse to the shared file again every time they reopen
  function showConnectModal(reconnectHandle) {
    connectUnsupportedMsg.hidden = FS_SUPPORTED;

    if (reconnectHandle && FS_SUPPORTED) {
      pendingReconnectHandle = reconnectHandle;
      reconnectSection.hidden = false;
      connectActions.hidden = true;
    } else {
      pendingReconnectHandle = null;
      reconnectSection.hidden = true;
      connectActions.hidden = !FS_SUPPORTED;
    }

    connectModalOverlay.hidden = false;
  }

  function hideConnectModal() {
    connectModalOverlay.hidden = true;
  }

  async function finishConnect(handle) {
    pendingSavedHandle = null;
    fileHandle = handle;
    await idbSet(IDB_KEY, handle);
    await loadAllFromDisk();
    state.readOnly = !(await testWriteAccess());
    updateFileStatusUI();
    updateReadOnlyUI();
    hideConnectModal();
    renderListItems();
    renderStockItems();
    startPolling();
    if (state.readOnly) alert(t("alert_read_only"));
  }

  // Silently retries the saved handle's permission using the user's next
  // click anywhere on the page as the required gesture, so reconnecting
  // after reopening the browser normally needs no dedicated button at all.
  function armAutoReconnect() {
    const attempt = async () => {
      if (fileHandle || !pendingSavedHandle) return;
      const handle = pendingSavedHandle;
      try {
        if (await ensureReadWritePermission(handle)) {
          await finishConnect(handle);
          return;
        }
      } catch (err) {
        console.error(err);
      }
      // the quiet attempt genuinely failed (e.g. permission denied, file
      // moved/deleted) -- fall back to the explicit reconnect prompt
      showConnectModal(handle);
    };
    document.addEventListener("pointerdown", attempt, { capture: true, once: true });
  }

  // Used by actions that require a connected file: if a saved handle is
  // still waiting on permission, this click is used to grant it on the
  // spot instead of bouncing the user to the connect modal.
  async function ensureConnectedOrPrompt() {
    if (fileHandle) return true;
    if (pendingSavedHandle) {
      const handle = pendingSavedHandle;
      try {
        if (await ensureReadWritePermission(handle)) {
          await finishConnect(handle);
          return true;
        }
      } catch (err) {
        console.error(err);
      }
    }
    showConnectModal(pendingSavedHandle || undefined);
    return false;
  }

  connectOpenBtn.addEventListener("click", async () => {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "QL VPP data", accept: { "application/json": [".json"] } }],
        excludeAcceptAllOption: false,
      });
      if (!(await ensureReadWritePermission(handle))) {
        alert(t("alert_permission_denied"));
        return;
      }
      await finishConnect(handle);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error(err);
        alert(t("alert_file_pick_failed"));
      }
    }
  });

  connectCreateBtn.addEventListener("click", async () => {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "qlvpp-data.json",
        types: [{ description: "QL VPP data", accept: { "application/json": [".json"] } }],
      });
      if (!(await ensureReadWritePermission(handle))) {
        alert(t("alert_permission_denied"));
        return;
      }
      fileHandle = handle;
      await writeDataFile({ items: [], movements: [] });
      await finishConnect(handle);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error(err);
        alert(t("alert_file_pick_failed"));
      }
    }
  });

  reconnectBtn.addEventListener("click", async () => {
    if (!pendingReconnectHandle) return;
    try {
      if (!(await ensureReadWritePermission(pendingReconnectHandle))) {
        alert(t("alert_permission_denied"));
        return;
      }
      await finishConnect(pendingReconnectHandle);
    } catch (err) {
      console.error(err);
      alert(t("alert_file_pick_failed"));
    }
  });

  reconnectPickOtherBtn.addEventListener("click", () => showConnectModal());

  fileChangeBtn.addEventListener("click", () => {
    if (pollTimer) clearInterval(pollTimer);
    fileHandle = null;
    updateFileStatusUI();
    showConnectModal();
  });

  // ================= i18n =================
  const TRANSLATIONS = {
    ko: {
      nav_list: "소모품 목록",
      nav_stock: "입출고 관리",
      register_h3: "소모품 등록",
      register_hint: "여러 소모품을 한 번에 등록할 수 있습니다. 사진은 선택 사항입니다.",
      th_photo: "사진",
      th_name: "품목명",
      th_unit: "단위",
      th_note: "비고",
      add_row_btn: "+ 행 추가",
      bulk_save_btn: "일괄 등록",
      list_query_h3: "등록된 소모품 조회",
      search_placeholder: "품목명으로 검색...",
      list_empty: "등록된 소모품이 없습니다.",
      stock_empty: "등록된 소모품이 없습니다. 소모품 목록에서 먼저 등록해주세요.",
      th_total_in: "총입고수량",
      th_total_out: "총불출수량",
      th_current: "현재고",
      th_consumption: "월간 소비 사이클",
      label_date: "날짜",
      label_qty: "수량",
      label_recipient: "수령자",
      placeholder_recipient: "수령자 이름",
      cancel_btn: "취소",
      save_btn: "저장",
      label_year: "연도",
      label_month: "월",
      th_in_short: "입고",
      th_out_short: "출고",
      history_empty: "입출고 이력이 없습니다.",
      close_btn: "닫기",
      delete_btn: "삭제",
      in_btn: "입고",
      out_btn: "출고",
      history_btn: "이력",
      modal_title_in: "입고 등록",
      modal_title_out: "출고 등록",
      unit_label: " / 단위: {unit}",
      alert_need_name: "등록할 소모품의 품목명을 입력해주세요.",
      alert_added_count: "{count}개의 소모품이 등록되었습니다.",
      confirm_delete_item: "이 소모품을 삭제하시겠습니까? 관련 입출고 내역은 유지됩니다.",
      alert_invalid_date: "날짜를 올바르게 입력해주세요. (예: 2026-08-07)",
      alert_invalid_qty: "수량을 올바르게 입력해주세요.",
      alert_need_recipient: "수령자를 입력해주세요.",
      consumption_none: "이력 없음",
      consumption_rate: "월 평균 소비량: 약 {avg}개",
      consumption_warning: "⚠ 재고 부족",
      consumption_ok: "재고 충분",
      filter_all: "전체",
      month_option: "{n}월",
      history_title_suffix: "입출고 이력",
      alert_server_error: "데이터 파일과 통신 중 오류가 발생했습니다. 연결 상태를 확인해주세요.",
      connect_title: "데이터 파일 연결",
      connect_desc: "공유 폴더에 있는 데이터 파일을 선택하면, 같은 파일을 연결한 모든 사람과 소모품·입출고 내용이 함께 공유됩니다.",
      connect_unsupported: "이 브라우저는 지원되지 않습니다. Chrome 또는 Edge 최신 버전으로 열어주세요.",
      connect_open_btn: "기존 파일 열기",
      connect_create_btn: "새 파일 만들기",
      file_status_connected: "연결됨: {name}",
      file_status_disconnected: "데이터 파일 연결 안 됨",
      file_status_reconnecting: "재연결 대기 중 (화면을 클릭하면 자동 연결)",
      file_status_readonly_suffix: "(읽기 전용)",
      alert_read_only: "이 파일은 읽기만 가능합니다. 등록·삭제·입출고 기록을 하려면 폴더/파일의 쓰기 권한이 필요합니다. 공유 폴더 관리자에게 '수정' 권한을 요청해주세요.",
      file_change_btn: "변경",
      alert_permission_denied: "데이터 파일에 대한 접근 권한이 거부되었습니다.",
      alert_file_pick_failed: "데이터 파일을 열지 못했습니다.",
      reconnect_desc: "이전에 연결했던 파일이 있습니다. 다시 연결하면 파일을 새로 찾지 않아도 됩니다.",
      reconnect_btn: "다시 연결",
      reconnect_pick_other_btn: "다른 파일 선택",
    },
    vi: {
      nav_list: "Danh sách vật tư tiêu hao",
      nav_stock: "Quản lý nhập xuất",
      register_h3: "Đăng ký vật tư tiêu hao",
      register_hint: "Bạn có thể đăng ký nhiều vật tư cùng một lúc. Ảnh là tùy chọn.",
      th_photo: "Ảnh",
      th_name: "Tên vật tư",
      th_unit: "Đơn vị",
      th_note: "Ghi chú",
      add_row_btn: "+ Thêm dòng",
      bulk_save_btn: "Đăng ký hàng loạt",
      list_query_h3: "Xem vật tư đã đăng ký",
      search_placeholder: "Tìm theo tên vật tư...",
      list_empty: "Chưa có vật tư tiêu hao nào được đăng ký.",
      stock_empty: "Chưa có vật tư nào. Vui lòng đăng ký vật tư trong Danh sách vật tư tiêu hao trước.",
      th_total_in: "Tổng số lượng nhập",
      th_total_out: "Tổng số lượng xuất",
      th_current: "Tồn kho hiện tại",
      th_consumption: "Chu kỳ tiêu thụ hàng tháng",
      label_date: "Ngày",
      label_qty: "Số lượng",
      label_recipient: "Người nhận",
      placeholder_recipient: "Tên người nhận",
      cancel_btn: "Hủy",
      save_btn: "Lưu",
      label_year: "Năm",
      label_month: "Tháng",
      th_in_short: "Nhập",
      th_out_short: "Xuất",
      history_empty: "Không có lịch sử nhập xuất.",
      close_btn: "Đóng",
      delete_btn: "Xóa",
      in_btn: "Nhập",
      out_btn: "Xuất",
      history_btn: "Lịch sử",
      modal_title_in: "Đăng ký nhập kho",
      modal_title_out: "Đăng ký xuất kho",
      unit_label: " / Đơn vị: {unit}",
      alert_need_name: "Vui lòng nhập tên vật tư cần đăng ký.",
      alert_added_count: "Đã đăng ký {count} vật tư.",
      confirm_delete_item: "Bạn có muốn xóa vật tư này không? Lịch sử nhập xuất liên quan vẫn được giữ lại.",
      alert_invalid_date: "Vui lòng nhập ngày hợp lệ. (Ví dụ: 2026-08-07)",
      alert_invalid_qty: "Vui lòng nhập số lượng hợp lệ.",
      alert_need_recipient: "Vui lòng nhập tên người nhận.",
      consumption_none: "Chưa có lịch sử",
      consumption_rate: "Tiêu thụ TB/tháng: khoảng {avg}",
      consumption_warning: "⚠ Thiếu tồn kho",
      consumption_ok: "Đủ tồn kho",
      filter_all: "Tất cả",
      month_option: "Tháng {n}",
      history_title_suffix: "Lịch sử nhập xuất",
      alert_server_error: "Đã xảy ra lỗi khi kết nối với tệp dữ liệu. Vui lòng kiểm tra kết nối.",
      connect_title: "Kết nối tệp dữ liệu",
      connect_desc: "Chọn tệp dữ liệu trong thư mục dùng chung để chia sẻ vật tư và lịch sử nhập xuất với mọi người đã kết nối cùng tệp.",
      connect_unsupported: "Trình duyệt này không được hỗ trợ. Vui lòng mở bằng Chrome hoặc Edge phiên bản mới nhất.",
      connect_open_btn: "Mở tệp có sẵn",
      connect_create_btn: "Tạo tệp mới",
      file_status_connected: "Đã kết nối: {name}",
      file_status_disconnected: "Chưa kết nối tệp dữ liệu",
      file_status_reconnecting: "Đang chờ kết nối lại (nhấn vào màn hình để tự động kết nối)",
      file_status_readonly_suffix: "(chỉ đọc)",
      alert_read_only: "Tệp này chỉ có thể xem, không thể ghi. Để đăng ký/xóa vật tư hoặc ghi nhập xuất, cần quyền ghi trên thư mục/tệp. Vui lòng liên hệ quản trị viên thư mục dùng chung để được cấp quyền 'Chỉnh sửa'.",
      file_change_btn: "Đổi",
      alert_permission_denied: "Quyền truy cập tệp dữ liệu đã bị từ chối.",
      alert_file_pick_failed: "Không thể mở tệp dữ liệu.",
      reconnect_desc: "Đã có tệp từng được kết nối trước đó. Kết nối lại để không phải tìm tệp lại từ đầu.",
      reconnect_btn: "Kết nối lại",
      reconnect_pick_other_btn: "Chọn tệp khác",
    },
  };

  function loadLang() {
    const saved = localStorage.getItem(LANG_KEY);
    return saved === "vi" || saved === "ko" ? saved : "ko";
  }

  const state = {
    items: [],
    movements: [],
    stockSearchTerm: "",
    listSearchTerm: "",
    modalItemId: null,
    modalType: "입고",
    historyItemId: null,
    lang: loadLang(),
    readOnly: false,
  };

  function t(key, vars) {
    let str = TRANSLATIONS[state.lang][key] ?? TRANSLATIONS.ko[key] ?? key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        str = str.replace(`{${k}}`, vars[k]);
      });
    }
    return str;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function photoCellHtml(photo) {
    return photo
      ? `<img class="photo-thumb" src="${photo}" alt="">`
      : `<span class="photo-thumb-empty"></span>`;
  }

  // ================= Navigation =================
  const navButtons = document.querySelectorAll(".nav-btn");
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      navButtons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`view-${btn.dataset.view}`).classList.add("active");
    });
  });

  // ================= Language switcher =================
  const langButtons = document.querySelectorAll(".lang-btn");

  function applyLanguage() {
    document.documentElement.lang = state.lang;

    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });

    langButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === state.lang);
    });

    // re-render dynamically generated content in the new language, without
    // losing in-progress bulk-registration input or photos
    applyBulkRowPlaceholders();
    renderListItems();
    renderStockItems();
    updateFileStatusUI();

    if (!modalOverlay.hidden) {
      modalTitle.textContent = state.modalType === "입고" ? t("modal_title_in") : t("modal_title_out");
      const item = state.items.find((it) => it.id === state.modalItemId);
      if (item) {
        modalItemName.textContent = `${item.name}${item.unit ? t("unit_label", { unit: item.unit }) : ""}`;
      }
    }

    const prevYear = historyYearSelect.value;
    const prevMonth = historyMonthSelect.value;
    populateHistoryFilters();
    historyYearSelect.value = prevYear;
    historyMonthSelect.value = prevMonth;

    if (!historyModalOverlay.hidden && state.historyItemId) {
      const item = state.items.find((it) => it.id === state.historyItemId);
      if (item) historyModalTitle.textContent = `${item.name} ${t("history_title_suffix")}`;
      renderHistoryTable();
    }
  }

  langButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.lang === state.lang) return;
      state.lang = btn.dataset.lang;
      localStorage.setItem(LANG_KEY, state.lang);
      applyLanguage();
    });
  });

  // ================= Custom date input (YYYY / MM / DD) =================
  // Fixes: native date inputs allowed the year segment to accept up to 6
  // digits in some browsers. Each segment here is a plain text input with
  // an enforced digit-only, length-limited value, and typing a full segment
  // automatically advances focus to the next one.
  function sanitizeDigits(value, maxLen) {
    return value.replace(/\D/g, "").slice(0, maxLen);
  }

  function initDateInput(container) {
    const yyyy = container.querySelector(".date-yyyy");
    const mm = container.querySelector(".date-mm");
    const dd = container.querySelector(".date-dd");

    yyyy.addEventListener("input", () => {
      yyyy.value = sanitizeDigits(yyyy.value, 4);
      if (yyyy.value.length === 4) {
        mm.focus();
        mm.select();
      }
    });

    mm.addEventListener("input", () => {
      mm.value = sanitizeDigits(mm.value, 2);
      if (mm.value.length === 2) {
        dd.focus();
        dd.select();
      }
    });

    dd.addEventListener("input", () => {
      dd.value = sanitizeDigits(dd.value, 2);
    });

    // backspace on an empty segment jumps back to the previous one
    mm.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && mm.value === "") yyyy.focus();
    });
    dd.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && dd.value === "") mm.focus();
    });

    // pad single-digit month/day with a leading zero once the user leaves the field
    mm.addEventListener("blur", () => {
      if (mm.value.length === 1) mm.value = mm.value.padStart(2, "0");
    });
    dd.addEventListener("blur", () => {
      if (dd.value.length === 1) dd.value = dd.value.padStart(2, "0");
    });

    return { yyyy, mm, dd };
  }

  function getDateValue(fields) {
    const y = fields.yyyy.value;
    const m = fields.mm.value.padStart(2, "0");
    const d = fields.dd.value.padStart(2, "0");
    if (y.length !== 4 || !fields.mm.value || !fields.dd.value) return null;

    const mNum = Number(m);
    const dNum = Number(d);
    if (mNum < 1 || mNum > 12) return null;
    if (dNum < 1 || dNum > 31) return null;

    return `${y}-${m}-${d}`;
  }

  function setDateValue(fields, dateStr) {
    const [y, m, d] = dateStr.split("-");
    fields.yyyy.value = y || "";
    fields.mm.value = m || "";
    fields.dd.value = d || "";
  }

  // ================= 소모품 등록 (bulk) =================
  const bulkTbody = document.getElementById("bulk-item-tbody");
  const addRowBtn = document.getElementById("add-row-btn");
  const bulkSaveBtn = document.getElementById("bulk-save-btn");

  let bulkRowSeq = 0;
  const bulkPhotos = new Map(); // rowId -> dataURL

  function applyBulkRowPlaceholders() {
    bulkTbody.querySelectorAll(".bulk-name").forEach((el) => (el.placeholder = t("th_name")));
    bulkTbody.querySelectorAll(".bulk-unit").forEach((el) => (el.placeholder = t("th_unit")));
    bulkTbody.querySelectorAll(".bulk-note").forEach((el) => (el.placeholder = t("th_note")));
    bulkTbody.querySelectorAll(".bulk-row-delete").forEach((el) => (el.textContent = t("delete_btn")));
  }

  function addBulkRow() {
    const rowId = `row-${++bulkRowSeq}`;
    bulkPhotos.set(rowId, "");

    const tr = document.createElement("tr");
    tr.dataset.rowId = rowId;
    tr.innerHTML = `
      <td class="photo-cell">
        <input type="file" accept="image/*" class="photo-input" data-row-id="${rowId}">
        <img class="photo-preview" data-row-id="${rowId}" hidden alt="">
      </td>
      <td><input type="text" class="bulk-name" placeholder="${t("th_name")}"></td>
      <td><input type="text" class="bulk-unit" placeholder="${t("th_unit")}"></td>
      <td><input type="text" class="bulk-note" placeholder="${t("th_note")}"></td>
      <td><button type="button" class="delete-btn bulk-row-delete">${t("delete_btn")}</button></td>
    `;
    bulkTbody.appendChild(tr);

    tr.querySelector(".photo-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        bulkPhotos.set(rowId, reader.result);
        const img = tr.querySelector(".photo-preview");
        img.src = reader.result;
        img.hidden = false;
      };
      reader.readAsDataURL(file);
    });

    tr.querySelector(".bulk-row-delete").addEventListener("click", () => {
      bulkPhotos.delete(rowId);
      tr.remove();
    });
  }

  function resetBulkRows(initialCount = 1) {
    bulkTbody.innerHTML = "";
    bulkPhotos.clear();
    for (let i = 0; i < initialCount; i++) addBulkRow();
  }

  addRowBtn.addEventListener("click", () => addBulkRow());

  bulkSaveBtn.addEventListener("click", async () => {
    const rows = Array.from(bulkTbody.querySelectorAll("tr"));
    const payload = [];

    rows.forEach((tr) => {
      const name = tr.querySelector(".bulk-name").value.trim();
      if (!name) return;

      payload.push({
        name,
        unit: tr.querySelector(".bulk-unit").value.trim(),
        note: tr.querySelector(".bulk-note").value.trim(),
        photo: bulkPhotos.get(tr.dataset.rowId) || "",
      });
    });

    if (payload.length === 0) {
      alert(t("alert_need_name"));
      return;
    }

    if (!(await ensureConnectedOrPrompt())) return;

    bulkSaveBtn.disabled = true;
    try {
      const created = await addItemsBulk(payload);
      state.items.push(...created);
      resetBulkRows();
      renderListItems();
      renderStockItems();
      alert(t("alert_added_count", { count: created.length }));
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    } finally {
      bulkSaveBtn.disabled = false;
    }
  });

  resetBulkRows();

  // ================= 소모품 목록 (조회) =================
  const listSearchInput = document.getElementById("list-search");
  const listTbody = document.getElementById("list-item-tbody");
  const listEmptyMsg = document.getElementById("list-item-empty");

  listSearchInput.addEventListener("input", () => {
    state.listSearchTerm = listSearchInput.value.trim().toLowerCase();
    renderListItems();
  });

  function filterItems(items, term) {
    if (!term) return items;
    return items.filter((it) => it.name.toLowerCase().includes(term));
  }

  function renderListItems() {
    const filtered = filterItems(state.items, state.listSearchTerm);
    listTbody.innerHTML = "";

    filtered.forEach((item) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${photoCellHtml(item.photo)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(item.note)}</td>
        <td><button type="button" class="delete-btn" data-id="${item.id}" ${state.readOnly ? "disabled" : ""}>${t("delete_btn")}</button></td>
      `;
      listTbody.appendChild(tr);
    });

    listEmptyMsg.hidden = filtered.length !== 0;

    listTbody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteItem(btn.dataset.id));
    });
  }

  async function deleteItem(id) {
    if (!(await ensureConnectedOrPrompt())) return;
    if (!confirm(t("confirm_delete_item"))) return;
    try {
      await deleteItemOnDisk(id);
      state.items = state.items.filter((it) => it.id !== id);
      renderListItems();
      renderStockItems();
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    }
  }

  // ================= 입출고 관리 =================
  const stockSearchInput = document.getElementById("stock-search");
  const stockTbody = document.getElementById("stock-item-tbody");
  const stockEmptyMsg = document.getElementById("stock-item-empty");

  stockSearchInput.addEventListener("input", () => {
    state.stockSearchTerm = stockSearchInput.value.trim().toLowerCase();
    renderStockItems();
  });

  function getItemTotals(itemId) {
    let totalIn = 0;
    let totalOut = 0;
    state.movements.forEach((m) => {
      if (m.itemId !== itemId) return;
      if (m.type === "입고") totalIn += m.qty;
      else if (m.type === "출고") totalOut += m.qty;
    });
    return { totalIn, totalOut, current: totalIn - totalOut };
  }

  // Monthly consumption cycle: average 출고(outgoing) quantity per month,
  // based on the span from the earliest recorded 출고 date up to today.
  function getMonthlyConsumption(itemId) {
    const outs = state.movements.filter((m) => m.itemId === itemId && m.type === "출고");
    if (outs.length === 0) return null;

    const totalOut = outs.reduce((sum, m) => sum + m.qty, 0);
    const earliestDate = outs.map((m) => m.date).sort()[0];
    const [ey, em] = earliestDate.split("-").map(Number);
    const now = new Date();
    const monthsSpan = Math.max(1, (now.getFullYear() - ey) * 12 + (now.getMonth() + 1 - em) + 1);

    return { avgPerMonth: totalOut / monthsSpan };
  }

  function consumptionCycleHtml(itemId, currentStock) {
    const consumption = getMonthlyConsumption(itemId);
    if (!consumption) {
      return `<span class="consumption-none">${t("consumption_none")}</span>`;
    }

    const avg = consumption.avgPerMonth;
    const isShort = currentStock < avg;
    const badge = isShort
      ? `<span class="consumption-warning">${t("consumption_warning")}</span>`
      : `<span class="consumption-ok">${t("consumption_ok")}</span>`;

    return `
      <div class="consumption-rate">${t("consumption_rate", { avg: avg.toFixed(1) })}</div>
      ${badge}
    `;
  }

  function renderStockItems() {
    const filtered = filterItems(state.items, state.stockSearchTerm);
    stockTbody.innerHTML = "";

    filtered.forEach((item) => {
      const { totalIn, totalOut, current } = getItemTotals(item.id);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${photoCellHtml(item.photo)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${totalIn}</td>
        <td>${totalOut}</td>
        <td class="current-stock ${current < 0 ? "negative" : ""}">${current}</td>
        <td>
          <div class="stock-actions">
            <button type="button" class="stock-in-btn" data-id="${item.id}" data-type="입고" ${state.readOnly ? "disabled" : ""}>${t("in_btn")}</button>
            <button type="button" class="stock-out-btn" data-id="${item.id}" data-type="출고" ${state.readOnly ? "disabled" : ""}>${t("out_btn")}</button>
            <button type="button" class="stock-history-btn" data-id="${item.id}">${t("history_btn")}</button>
          </div>
        </td>
        <td class="consumption-cycle">${consumptionCycleHtml(item.id, current)}</td>
      `;
      stockTbody.appendChild(tr);
    });

    stockEmptyMsg.hidden = filtered.length !== 0;

    stockTbody.querySelectorAll(".stock-in-btn, .stock-out-btn").forEach((btn) => {
      btn.addEventListener("click", () => openStockModal(btn.dataset.id, btn.dataset.type));
    });
    stockTbody.querySelectorAll(".stock-history-btn").forEach((btn) => {
      btn.addEventListener("click", () => openHistoryModal(btn.dataset.id));
    });
  }

  // ---------- 입고/출고 모달 ----------
  const modalOverlay = document.getElementById("stock-modal-overlay");
  const modalTitle = document.getElementById("stock-modal-title");
  const modalItemName = document.getElementById("stock-modal-item-name");
  const modalForm = document.getElementById("stock-modal-form");
  const modalQtyInput = document.getElementById("modal-qty");
  const modalRecipientInput = document.getElementById("modal-recipient");
  const modalCancelBtn = document.getElementById("stock-modal-cancel");

  const modalDateContainer = document.querySelector('[data-date-input="modal-date"]');
  const modalDateFields = initDateInput(modalDateContainer);

  async function openStockModal(itemId, type) {
    if (!(await ensureConnectedOrPrompt())) return;
    const item = state.items.find((it) => it.id === itemId);
    if (!item) return;

    state.modalItemId = itemId;
    state.modalType = type;

    modalTitle.textContent = type === "입고" ? t("modal_title_in") : t("modal_title_out");
    modalItemName.textContent = `${item.name}${item.unit ? t("unit_label", { unit: item.unit }) : ""}`;
    modalQtyInput.value = "";
    modalRecipientInput.value = "";
    setDateValue(modalDateFields, new Date().toISOString().slice(0, 10));

    modalOverlay.hidden = false;
    modalQtyInput.focus();
  }

  function closeStockModal() {
    modalOverlay.hidden = true;
    state.modalItemId = null;
  }

  modalCancelBtn.addEventListener("click", closeStockModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeStockModal();
  });

  modalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = state.items.find((it) => it.id === state.modalItemId);
    if (!item) return;

    const date = getDateValue(modalDateFields);
    if (!date) {
      alert(t("alert_invalid_date"));
      return;
    }

    const qty = Number(modalQtyInput.value);
    if (!qty || qty <= 0) {
      alert(t("alert_invalid_qty"));
      return;
    }

    const recipient = modalRecipientInput.value.trim();
    if (!recipient) {
      alert(t("alert_need_recipient"));
      return;
    }

    const payload = {
      itemId: item.id,
      itemName: item.name,
      itemUnit: item.unit,
      type: state.modalType,
      date,
      qty,
      recipient,
    };

    const submitBtn = document.getElementById("stock-modal-submit");
    submitBtn.disabled = true;
    try {
      const movement = await addMovementOnDisk(payload);
      state.movements.unshift(movement);
      closeStockModal();
      renderStockItems();
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------- 입출고 이력 모달 ----------
  const historyModalOverlay = document.getElementById("history-modal-overlay");
  const historyModalTitle = document.getElementById("history-modal-title");
  const historyTbody = document.getElementById("history-tbody");
  const historyEmptyMsg = document.getElementById("history-empty");
  const historyModalCloseBtn = document.getElementById("history-modal-close");
  const historyYearSelect = document.getElementById("history-year");
  const historyMonthSelect = document.getElementById("history-month");

  const HISTORY_START_YEAR = 2026;

  function populateHistoryFilters() {
    const currentYear = new Date().getFullYear();
    const lastYear = Math.max(currentYear + 5, HISTORY_START_YEAR);

    historyYearSelect.innerHTML = `<option value="">${t("filter_all")}</option>`;
    for (let y = HISTORY_START_YEAR; y <= lastYear; y++) {
      historyYearSelect.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
    }

    historyMonthSelect.innerHTML = `<option value="">${t("filter_all")}</option>`;
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      historyMonthSelect.insertAdjacentHTML("beforeend", `<option value="${mm}">${t("month_option", { n: m })}</option>`);
    }
  }

  populateHistoryFilters();

  function openHistoryModal(itemId) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item) return;

    state.historyItemId = itemId;
    historyModalTitle.textContent = `${item.name} ${t("history_title_suffix")}`;
    historyYearSelect.value = "";
    historyMonthSelect.value = "";

    renderHistoryTable();
    historyModalOverlay.hidden = false;
  }

  function renderHistoryTable() {
    const itemId = state.historyItemId;
    if (!itemId) return;

    const selectedYear = historyYearSelect.value;
    const selectedMonth = historyMonthSelect.value;

    // most recent date first; within a date, most recently added first
    const entries = state.movements
      .filter((m) => {
        if (m.itemId !== itemId) return false;
        const [y, mo] = m.date.split("-");
        if (selectedYear && y !== selectedYear) return false;
        if (selectedMonth && mo !== selectedMonth) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    historyTbody.innerHTML = "";

    if (entries.length === 0) {
      historyEmptyMsg.hidden = false;
    } else {
      historyEmptyMsg.hidden = true;

      // group consecutive same-date entries so the date is only shown once,
      // spanning every entry recorded for that day
      let i = 0;
      while (i < entries.length) {
        const date = entries[i].date;
        let j = i;
        while (j < entries.length && entries[j].date === date) j++;
        const groupSize = j - i;

        for (let k = i; k < j; k++) {
          const entry = entries[k];
          const tr = document.createElement("tr");
          const dateCell = k === i ? `<td rowspan="${groupSize}" class="history-date-cell">${escapeHtml(date)}</td>` : "";
          const inCell = entry.type === "입고" ? escapeHtml(String(entry.qty)) : "-";
          const outCell = entry.type === "출고" ? escapeHtml(String(entry.qty)) : "-";
          tr.innerHTML = `
            ${dateCell}
            <td>${inCell}</td>
            <td>${outCell}</td>
            <td>${escapeHtml(entry.recipient)}</td>
          `;
          historyTbody.appendChild(tr);
        }
        i = j;
      }
    }
  }

  function closeHistoryModal() {
    historyModalOverlay.hidden = true;
    state.historyItemId = null;
  }

  historyYearSelect.addEventListener("change", renderHistoryTable);
  historyMonthSelect.addEventListener("change", renderHistoryTable);

  historyModalCloseBtn.addEventListener("click", closeHistoryModal);
  historyModalOverlay.addEventListener("click", (e) => {
    if (e.target === historyModalOverlay) closeHistoryModal();
  });

  // ================= init =================
  async function init() {
    applyLanguage(); // paint static UI immediately, before any file access

    if (!FS_SUPPORTED) {
      showConnectModal();
      return;
    }

    try {
      const savedHandle = await idbGet(IDB_KEY);
      if (savedHandle) {
        // queryPermission never prompts, so it's safe to call outside a
        // click handler. requestPermission needs a real user gesture, so
        // it's deferred to the user's next click anywhere in the app
        // (armAutoReconnect) instead of forcing a dedicated button here.
        const already = await savedHandle.queryPermission({ mode: "readwrite" });
        if (already === "granted") {
          await finishConnect(savedHandle);
          return;
        }
        pendingSavedHandle = savedHandle;
        updateFileStatusUI();
        armAutoReconnect();
        return;
      }
    } catch (err) {
      console.error(err);
    }

    showConnectModal();
  }

  init();
})();
