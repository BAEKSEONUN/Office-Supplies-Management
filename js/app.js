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
    // no pretty-printing: this file is only ever read/written by the app,
    // and indentation used to roughly double the bytes written on every
    // single save (which matters a lot on a network-shared file)
    await writable.write(JSON.stringify(data));
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
      target: Math.max(0, Number(entry.target) || 0),
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

  async function deleteItemsBulk(ids) {
    const idSet = new Set(ids);
    const data = await readDataFile();
    data.items = data.items.filter((it) => !idSet.has(it.id));
    await writeDataFile(data);
  }

  async function updateItemOnDisk(id, patch) {
    const data = await readDataFile();
    const item = data.items.find((it) => it.id === id);
    if (!item) throw new Error("item not found");
    Object.assign(item, patch);
    await writeDataFile(data);
    return item;
  }

  async function addMovementsBulk(entries) {
    const data = await readDataFile();
    const created = entries.map((entry) => ({ id: crypto.randomUUID(), ...entry }));
    data.movements.unshift(...created);
    await writeDataFile(data);
    return created;
  }

  async function loadAllFromDisk() {
    const data = await readDataFile();
    state.items = data.items;
    state.movements = data.movements;
    markUpdated();
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!fileHandle) return;
      try {
        const file = await fileHandle.getFile();
        if (file.lastModified === lastSeenModified) return; // no external change
        await loadAllFromDisk();
        renderInventoryTable();
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
    bulkMovementSaveBtn.disabled = state.readOnly;
    updateSelectionToolbar();
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
    renderInventoryTable();
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
      nav_dashboard: "재고 관리",
      banner_eyebrow: "INVENTORY CONTROL · 재고관리",
      banner_title: "소모품 재고관리",
      banner_subtitle: "적정재고 대비 재고율이 50% 이하로 떨어지면 자동으로 부족 상태가 표시됩니다.",
      banner_updated_label: "마지막 업데이트",
      banner_live: "REAL-TIME TRACKING",
      stat_total: "전체 품목",
      stat_shortage: "재고 부족 (50% 이하)",
      stat_warning: "주의 (50~80%)",
      stat_shortage_qty: "총 부족수량",
      unit_case: "건",
      unit_piece: "개",
      approx_prefix: "약 ",
      consumption_weekly: "주간 사용량",
      consumption_monthly: "월간 사용량",
      inventory_title: "소모품 목록",
      add_item_btn: "+ 품목 추가",
      bulk_movement_btn: "입출고 일괄 등록",
      export_btn: "↓ 엑셀 다운로드",
      search_placeholder: "품목명으로 검색...",
      th_photo: "사진",
      th_name: "소모품명",
      th_target: "적정재고수량",
      th_used: "사용수량",
      th_in: "입고수량",
      th_current: "현재재고",
      th_shortage: "부족수량",
      th_ratio: "재고율",
      th_status: "상태",
      th_unit: "단위",
      th_note: "비고",
      legend_ok: "정상 (재고율 80% 초과)",
      legend_warn: "주의 (재고율 50~80%)",
      legend_danger: "부족 (재고율 50% 이하 · 적색 표시)",
      formula_note: "SUPPLY INVENTORY DASHBOARD · 현재재고 = 적정재고수량 − 사용수량 + 입고수량 · 재고율 = 현재재고 ÷ 적정재고수량",
      status_ok: "정상",
      status_warn: "주의",
      status_danger: "부족",
      list_empty: "등록된 소모품이 없습니다.",
      add_row_btn: "+ 행 추가",
      bulk_save_btn: "일괄 등록",
      register_h3: "소모품 등록",
      register_hint: "여러 소모품을 한 번에 등록할 수 있습니다. 사진은 선택 사항입니다.",
      close_btn: "닫기",
      save_btn: "저장",
      bulk_movement_title: "입출고 일괄 등록",
      bulk_movement_hint: "여러 건의 입고/출고를 한 번에 등록할 수 있습니다.",
      movement_type: "구분",
      label_date: "날짜",
      label_qty: "수량",
      label_recipient: "수령자",
      placeholder_recipient: "수령자 이름",
      label_year: "연도",
      label_month: "월",
      th_in_short: "입고",
      th_out_short: "출고",
      history_empty: "입출고 이력이 없습니다.",
      delete_btn: "삭제",
      edit_btn: "수정",
      edit_item_title: "소모품 수정",
      selection_count: "{count}개 선택됨",
      alert_select_one_to_edit: "수정할 소모품을 하나만 선택해주세요.",
      confirm_delete_selected: "선택한 {count}개 소모품을 삭제하시겠습니까? 관련 입출고 내역은 유지됩니다.",
      alert_item_updated: "소모품 정보가 수정되었습니다.",
      in_btn: "입고",
      out_btn: "출고",
      history_btn: "이력",
      filter_all: "전체",
      month_option: "{n}월",
      history_title_suffix: "입출고 이력",
      alert_need_name: "등록할 소모품의 품목명을 입력해주세요.",
      alert_added_count: "{count}개의 소모품이 등록되었습니다.",
      alert_movement_added_count: "{count}건의 입출고가 등록되었습니다.",
      alert_need_items_first: "먼저 소모품을 등록해주세요.",
      alert_movement_rows_invalid: "입력한 행 중 날짜/수량/수령자가 올바르지 않은 행이 있습니다.",
      confirm_delete_item: "이 소모품을 삭제하시겠습니까? 관련 입출고 내역은 유지됩니다.",
      alert_invalid_date: "날짜를 올바르게 입력해주세요. (예: 2026-08-07)",
      alert_invalid_qty: "수량을 올바르게 입력해주세요.",
      alert_need_recipient: "수령자를 입력해주세요.",
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
      nav_dashboard: "Quản lý tồn kho",
      banner_eyebrow: "INVENTORY CONTROL · Quản lý tồn kho",
      banner_title: "Quản lý tồn kho vật tư",
      banner_subtitle: "Trạng thái thiếu hàng tự động hiển thị khi tỷ lệ tồn kho giảm xuống dưới 50% so với mức tồn kho hợp lý.",
      banner_updated_label: "Cập nhật lần cuối",
      banner_live: "REAL-TIME TRACKING",
      stat_total: "Tổng số mặt hàng",
      stat_shortage: "Thiếu hàng (≤ 50%)",
      stat_warning: "Cảnh báo (50~80%)",
      stat_shortage_qty: "Tổng số lượng thiếu",
      unit_case: "mục",
      unit_piece: "cái",
      approx_prefix: "khoảng ",
      consumption_weekly: "Tiêu thụ/tuần",
      consumption_monthly: "Tiêu thụ/tháng",
      inventory_title: "Danh sách vật tư",
      add_item_btn: "+ Thêm mặt hàng",
      bulk_movement_btn: "Đăng ký nhập xuất hàng loạt",
      export_btn: "↓ Tải Excel",
      search_placeholder: "Tìm theo tên vật tư...",
      th_photo: "Ảnh",
      th_name: "Tên vật tư",
      th_target: "Tồn kho hợp lý",
      th_used: "Số lượng đã dùng",
      th_in: "Số lượng nhập",
      th_current: "Tồn kho hiện tại",
      th_shortage: "Số lượng thiếu",
      th_ratio: "Tỷ lệ tồn kho",
      th_status: "Trạng thái",
      th_unit: "Đơn vị",
      th_note: "Ghi chú",
      legend_ok: "Bình thường (tỷ lệ trên 80%)",
      legend_warn: "Cảnh báo (tỷ lệ 50~80%)",
      legend_danger: "Thiếu hàng (tỷ lệ ≤ 50% · hiển thị đỏ)",
      formula_note: "SUPPLY INVENTORY DASHBOARD · Tồn kho hiện tại = Tồn kho hợp lý − Số lượng dùng + Số lượng nhập · Tỷ lệ tồn kho = Tồn kho hiện tại ÷ Tồn kho hợp lý",
      status_ok: "Bình thường",
      status_warn: "Cảnh báo",
      status_danger: "Thiếu hàng",
      list_empty: "Chưa có vật tư tiêu hao nào được đăng ký.",
      add_row_btn: "+ Thêm dòng",
      bulk_save_btn: "Đăng ký hàng loạt",
      register_h3: "Đăng ký vật tư tiêu hao",
      register_hint: "Bạn có thể đăng ký nhiều vật tư cùng một lúc. Ảnh là tùy chọn.",
      close_btn: "Đóng",
      save_btn: "Lưu",
      bulk_movement_title: "Đăng ký nhập xuất hàng loạt",
      bulk_movement_hint: "Bạn có thể đăng ký nhiều lượt nhập/xuất cùng một lúc.",
      movement_type: "Loại",
      label_date: "Ngày",
      label_qty: "Số lượng",
      label_recipient: "Người nhận",
      placeholder_recipient: "Tên người nhận",
      label_year: "Năm",
      label_month: "Tháng",
      th_in_short: "Nhập",
      th_out_short: "Xuất",
      history_empty: "Không có lịch sử nhập xuất.",
      delete_btn: "Xóa",
      edit_btn: "Sửa",
      edit_item_title: "Sửa vật tư",
      selection_count: "Đã chọn {count} mục",
      alert_select_one_to_edit: "Vui lòng chỉ chọn một vật tư để sửa.",
      confirm_delete_selected: "Bạn có muốn xóa {count} vật tư đã chọn không? Lịch sử nhập xuất liên quan vẫn được giữ lại.",
      alert_item_updated: "Đã cập nhật thông tin vật tư.",
      in_btn: "Nhập",
      out_btn: "Xuất",
      history_btn: "Lịch sử",
      filter_all: "Tất cả",
      month_option: "Tháng {n}",
      history_title_suffix: "Lịch sử nhập xuất",
      alert_need_name: "Vui lòng nhập tên vật tư cần đăng ký.",
      alert_added_count: "Đã đăng ký {count} vật tư.",
      alert_movement_added_count: "Đã đăng ký {count} lượt nhập xuất.",
      alert_need_items_first: "Vui lòng đăng ký vật tư trước.",
      alert_movement_rows_invalid: "Một số dòng có ngày/số lượng/người nhận không hợp lệ.",
      confirm_delete_item: "Bạn có muốn xóa vật tư này không? Lịch sử nhập xuất liên quan vẫn được giữ lại.",
      alert_invalid_date: "Vui lòng nhập ngày hợp lệ. (Ví dụ: 2026-08-07)",
      alert_invalid_qty: "Vui lòng nhập số lượng hợp lệ.",
      alert_need_recipient: "Vui lòng nhập tên người nhận.",
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
    inventorySearchTerm: "",
    historyItemId: null,
    lang: loadLang(),
    readOnly: false,
    lastUpdatedAt: null,
    selectedItemIds: new Set(),
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

  // Photos are only ever shown as small thumbnails, but an unprocessed
  // phone photo can be several MB — and since the whole data file gets
  // rewritten on every single save, that made every action on the shared
  // file slow. Downscale + re-encode as JPEG before it ever gets stored.
  const PHOTO_MAX_DIMENSION = 480;
  const PHOTO_JPEG_QUALITY = 0.72;

  function resizeImageFile(file, maxDim = PHOTO_MAX_DIMENSION, quality = PHOTO_JPEG_QUALITY) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round(height * (maxDim / width));
              width = maxDim;
            } else {
              width = Math.round(width * (maxDim / height));
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

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
    applyMovementRowPlaceholders();
    renderInventoryTable();
    updateFileStatusUI();
    updateSelectionToolbar();
    renderClock();

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

  // ================= Live clock / last-updated =================
  const bannerDateEl = document.getElementById("banner-date");
  const bannerTimeEl = document.getElementById("banner-time");
  const bannerUpdatedAtEl = document.getElementById("banner-updated-at");

  const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
  const WEEKDAYS_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const wd = state.lang === "vi" ? WEEKDAYS_VI[d.getDay()] : WEEKDAYS_KO[d.getDay()];
    return state.lang === "vi" ? `${day}/${m}/${y} (${wd})` : `${y}. ${m}. ${day}. (${wd})`;
  }

  function formatTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatDateTime(d) {
    return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function renderClock() {
    const now = new Date();
    bannerDateEl.textContent = formatDate(now);
    bannerTimeEl.textContent = formatTime(now);
    bannerUpdatedAtEl.textContent = state.lastUpdatedAt ? formatDateTime(state.lastUpdatedAt) : "-";
  }

  function markUpdated() {
    state.lastUpdatedAt = new Date();
    renderClock();
  }

  setInterval(renderClock, 1000);

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

  // ================= 소모품 등록 모달 (bulk) =================
  const itemModalOverlay = document.getElementById("item-modal-overlay");
  const itemModalCloseBtn = document.getElementById("item-modal-close");
  const openItemModalBtn = document.getElementById("open-item-modal-btn");
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

    tr.querySelector(".photo-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImageFile(file);
        bulkPhotos.set(rowId, dataUrl);
        const img = tr.querySelector(".photo-preview");
        img.src = dataUrl;
        img.hidden = false;
      } catch (err) {
        console.error("photo resize failed", err);
      }
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
  resetBulkRows();

  openItemModalBtn.addEventListener("click", () => {
    itemModalOverlay.hidden = false;
  });
  itemModalCloseBtn.addEventListener("click", () => {
    itemModalOverlay.hidden = true;
  });
  itemModalOverlay.addEventListener("click", (e) => {
    if (e.target === itemModalOverlay) itemModalOverlay.hidden = true;
  });

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
      markUpdated();
      resetBulkRows();
      renderInventoryTable();
      itemModalOverlay.hidden = true;
      alert(t("alert_added_count", { count: created.length }));
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    } finally {
      bulkSaveBtn.disabled = state.readOnly;
    }
  });

  // ---------- 소모품 수정 모달 ----------
  const editItemModalOverlay = document.getElementById("edit-item-modal-overlay");
  const editItemForm = document.getElementById("edit-item-form");
  const editItemPhotoInput = document.getElementById("edit-item-photo");
  const editItemPhotoPreview = document.getElementById("edit-item-photo-preview");
  const editItemNameInput = document.getElementById("edit-item-name");
  const editItemTargetInput = document.getElementById("edit-item-target");
  const editItemUnitInput = document.getElementById("edit-item-unit");
  const editItemNoteInput = document.getElementById("edit-item-note");
  const editItemCloseBtn = document.getElementById("edit-item-close");
  const editItemSaveBtn = document.getElementById("edit-item-save");

  let editingItemId = null;
  let editingItemPhoto = "";

  function openEditItemModal(item) {
    editingItemId = item.id;
    editingItemPhoto = item.photo || "";
    editItemNameInput.value = item.name;
    editItemTargetInput.value = item.target || 0;
    editItemUnitInput.value = item.unit || "";
    editItemNoteInput.value = item.note || "";
    editItemPhotoInput.value = "";
    if (editingItemPhoto) {
      editItemPhotoPreview.src = editingItemPhoto;
      editItemPhotoPreview.hidden = false;
    } else {
      editItemPhotoPreview.hidden = true;
    }
    editItemModalOverlay.hidden = false;
  }

  function closeEditItemModal() {
    editItemModalOverlay.hidden = true;
    editingItemId = null;
  }

  editItemCloseBtn.addEventListener("click", closeEditItemModal);
  editItemModalOverlay.addEventListener("click", (e) => {
    if (e.target === editItemModalOverlay) closeEditItemModal();
  });

  editItemPhotoInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      editingItemPhoto = await resizeImageFile(file);
      editItemPhotoPreview.src = editingItemPhoto;
      editItemPhotoPreview.hidden = false;
    } catch (err) {
      console.error("photo resize failed", err);
    }
  });

  editItemForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editingItemId) return;

    const name = editItemNameInput.value.trim();
    if (!name) {
      alert(t("alert_need_name"));
      return;
    }

    if (!(await ensureConnectedOrPrompt())) return;

    const patch = {
      name,
      target: Math.max(0, Number(editItemTargetInput.value) || 0),
      unit: editItemUnitInput.value.trim(),
      note: editItemNoteInput.value.trim(),
      photo: editingItemPhoto,
    };

    editItemSaveBtn.disabled = true;
    try {
      await updateItemOnDisk(editingItemId, patch);
      const item = state.items.find((it) => it.id === editingItemId);
      if (item) Object.assign(item, patch);
      markUpdated();
      closeEditItemModal();
      clearSelection();
      renderInventoryTable();
      alert(t("alert_item_updated"));
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    } finally {
      editItemSaveBtn.disabled = state.readOnly;
    }
  });

  // ================= 소모품 재고 대시보드 =================
  const inventorySearchInput = document.getElementById("inventory-search");
  const inventoryTbody = document.getElementById("inventory-tbody");
  const inventoryEmptyMsg = document.getElementById("inventory-empty");
  const inventoryCountEl = document.getElementById("inventory-count");

  const statTotalEl = document.getElementById("stat-total");
  const statShortageEl = document.getElementById("stat-shortage");
  const statWarningEl = document.getElementById("stat-warning");
  const statShortageQtyEl = document.getElementById("stat-shortage-qty");

  inventorySearchInput.addEventListener("input", () => {
    state.inventorySearchTerm = inventorySearchInput.value.trim().toLowerCase();
    renderInventoryTable();
  });

  function filterItems(items, term) {
    if (!term) return items;
    return items.filter((it) => it.name.toLowerCase().includes(term));
  }

  // Scans state.movements exactly once and buckets running totals per item,
  // instead of every item independently re-scanning the full movements
  // array (that O(items × movements) pattern is what made rendering slow
  // once the history grew — this turns it into O(items + movements)).
  function buildMovementIndex() {
    const index = new Map();
    state.movements.forEach((m) => {
      let entry = index.get(m.itemId);
      if (!entry) {
        entry = { totalIn: 0, totalOut: 0, outTotal: 0, earliestOutDate: null };
        index.set(m.itemId, entry);
      }
      if (m.type === "입고") {
        entry.totalIn += m.qty;
      } else if (m.type === "출고") {
        entry.totalOut += m.qty;
        entry.outTotal += m.qty;
        if (!entry.earliestOutDate || m.date < entry.earliestOutDate) entry.earliestOutDate = m.date;
      }
    });
    return index;
  }

  function getItemTotals(itemId, movementIndex) {
    const entry = movementIndex.get(itemId);
    return entry ? { totalIn: entry.totalIn, totalOut: entry.totalOut } : { totalIn: 0, totalOut: 0 };
  }

  // 현재재고 = 적정재고수량 − 사용수량(출고) + 입고수량
  // 재고율 = 현재재고 ÷ 적정재고수량
  // 상태: 재고율 > 80% 정상, 50% < 재고율 ≤ 80% 주의, 재고율 ≤ 50% 부족
  function computeItemStats(item, movementIndex) {
    const { totalIn, totalOut } = getItemTotals(item.id, movementIndex);
    const target = Math.max(0, Number(item.target) || 0);
    const current = target - totalOut + totalIn;
    const shortage = Math.max(0, target - current);
    const ratio = target > 0 ? Math.round((current / target) * 100) : 0;
    const status = ratio > 80 ? "ok" : ratio > 50 ? "warn" : "danger";
    return { target, totalIn, totalOut, current, shortage, ratio, status };
  }

  // 주간/월간 소요량: 최초 출고일부터 오늘까지의 일평균 출고량을 기준으로 환산
  // Monday-start-of-week, used to bucket 출고 records into calendar weeks.
  function startOfWeek(d) {
    const monday = new Date(d);
    const day = monday.getDay(); // 0 = Sun
    const diffToMonday = day === 0 ? 6 : day - 1;
    monday.setDate(monday.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }

  function countWeeksBetween(start, end) {
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    return Math.round((startOfWeek(end) - startOfWeek(start)) / msPerWeek) + 1;
  }

  function countMonthsBetween(start, end) {
    return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  }

  // 주간/월간 사용량 = 최초 출고일부터 오늘까지 걸친 주/월 개수로 총
  // 출고량을 나눈 값. 즉 "각 주차/월마다 사용한 수량의 평균". 사용하지
  // 않은 주/월도 기간에 포함되므로, 매 입출고 등록 시 재계산되는
  // 렌더링 흐름을 그대로 타면 자동으로 최신 값이 반영된다.
  function getConsumptionStats(itemId, movementIndex) {
    const entry = movementIndex.get(itemId);
    if (!entry || entry.outTotal === 0) return null;

    const earliest = new Date(`${entry.earliestOutDate}T00:00:00`);
    const now = new Date();

    const weeks = Math.max(1, countWeeksBetween(earliest, now));
    const months = Math.max(1, countMonthsBetween(earliest, now));

    return { weekly: entry.outTotal / weeks, monthly: entry.outTotal / months };
  }

  function consumptionLinesHtml(itemId, movementIndex) {
    const c = getConsumptionStats(itemId, movementIndex);
    const fmt = (n) => `${t("approx_prefix")}${n.toFixed(1)}${t("unit_piece")}`;
    const weeklyVal = c ? fmt(c.weekly) : "-";
    const monthlyVal = c ? fmt(c.monthly) : "-";
    return `
      <div class="consumption-lines">${t("consumption_weekly")} : ${weeklyVal} / ${t("consumption_monthly")} : ${monthlyVal}</div>
    `;
  }

  function statusBadgeHtml(status) {
    const key = status === "ok" ? "status_ok" : status === "warn" ? "status_warn" : "status_danger";
    return `<span class="status-badge status-${status}">${t(key)}</span>`;
  }

  function ratioCellHtml(ratio, status) {
    const clamped = Math.max(0, Math.min(100, ratio));
    const fillClass = status === "warn" ? "warn" : status === "danger" ? "danger" : "";
    return `
      <span class="ratio-bar-track"><span class="ratio-bar-fill ${fillClass}" style="width:${clamped}%"></span></span>
      <span class="ratio-pct">${ratio}%</span>
    `;
  }

  function updateStatCards(movementIndex) {
    let shortageCount = 0;
    let warningCount = 0;
    let totalShortageQty = 0;

    state.items.forEach((item) => {
      const { shortage, status } = computeItemStats(item, movementIndex);
      totalShortageQty += shortage;
      if (status === "danger") shortageCount++;
      else if (status === "warn") warningCount++;
    });

    statTotalEl.textContent = state.items.length;
    statShortageEl.textContent = shortageCount;
    statWarningEl.textContent = warningCount;
    statShortageQtyEl.textContent = totalShortageQty;
    inventoryCountEl.textContent = `${state.items.length}${t("unit_case")}`;
  }

  function renderInventoryTable() {
    const movementIndex = buildMovementIndex();
    const filtered = filterItems(state.items, state.inventorySearchTerm);
    inventoryTbody.innerHTML = "";

    filtered.forEach((item) => {
      const stats = computeItemStats(item, movementIndex);
      const tr = document.createElement("tr");
      tr.dataset.id = item.id;
      tr.classList.toggle("row-selected", state.selectedItemIds.has(item.id));
      tr.innerHTML = `
        <td class="item-name-cell">
          <div class="item-name-row">
            <div class="item-name-main">${photoCellHtml(item.photo)}<span>${escapeHtml(item.name)}</span></div>
            ${consumptionLinesHtml(item.id, movementIndex)}
          </div>
        </td>
        <td>${stats.target}</td>
        <td>${stats.totalOut}</td>
        <td>${stats.totalIn}</td>
        <td>${stats.current}</td>
        <td class="shortage-cell ${stats.shortage > 0 ? "has-shortage" : ""}">${stats.shortage}</td>
        <td class="ratio-cell">${ratioCellHtml(stats.ratio, stats.status)}</td>
        <td>${statusBadgeHtml(stats.status)}</td>
        <td>
          <div class="stock-actions">
            <button type="button" class="stock-in-btn" data-id="${item.id}" data-type="입고" ${state.readOnly ? "disabled" : ""}>${t("in_btn")}</button>
            <button type="button" class="stock-out-btn" data-id="${item.id}" data-type="출고" ${state.readOnly ? "disabled" : ""}>${t("out_btn")}</button>
            <button type="button" class="stock-history-btn" data-id="${item.id}">${t("history_btn")}</button>
          </div>
        </td>
      `;
      inventoryTbody.appendChild(tr);
    });

    inventoryEmptyMsg.hidden = filtered.length !== 0;

    inventoryTbody.querySelectorAll(".stock-in-btn, .stock-out-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!(await ensureConnectedOrPrompt())) return;
        openMovementModal({ itemId: btn.dataset.id, type: btn.dataset.type });
      });
    });
    inventoryTbody.querySelectorAll(".stock-history-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openHistoryModal(btn.dataset.id);
      });
    });
    inventoryTbody.querySelectorAll("tr").forEach((tr) => {
      tr.addEventListener("click", () => toggleRowSelection(tr.dataset.id));
    });

    updateStatCards(movementIndex);
  }

  // ---------- 행 선택 / 선택 항목 수정·삭제 ----------
  const selectionToolbar = document.getElementById("selection-toolbar");
  const selectionCountText = document.getElementById("selection-count-text");
  const selectionEditBtn = document.getElementById("selection-edit-btn");
  const selectionDeleteBtn = document.getElementById("selection-delete-btn");

  function toggleRowSelection(id) {
    if (state.selectedItemIds.has(id)) state.selectedItemIds.delete(id);
    else state.selectedItemIds.add(id);
    renderInventoryTable();
    updateSelectionToolbar();
  }

  function clearSelection() {
    state.selectedItemIds.clear();
    updateSelectionToolbar();
  }

  function updateSelectionToolbar() {
    const count = state.selectedItemIds.size;
    selectionToolbar.hidden = count === 0;
    selectionCountText.textContent = t("selection_count", { count });
    selectionEditBtn.disabled = count !== 1 || state.readOnly;
    selectionDeleteBtn.disabled = count === 0 || state.readOnly;
  }

  selectionDeleteBtn.addEventListener("click", async () => {
    if (!(await ensureConnectedOrPrompt())) return;
    const ids = Array.from(state.selectedItemIds);
    if (ids.length === 0) return;
    if (!confirm(t("confirm_delete_selected", { count: ids.length }))) return;
    try {
      await deleteItemsBulk(ids);
      state.items = state.items.filter((it) => !state.selectedItemIds.has(it.id));
      markUpdated();
      clearSelection();
      renderInventoryTable();
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    }
  });

  selectionEditBtn.addEventListener("click", async () => {
    if (state.selectedItemIds.size !== 1) {
      alert(t("alert_select_one_to_edit"));
      return;
    }
    if (!(await ensureConnectedOrPrompt())) return;
    const id = Array.from(state.selectedItemIds)[0];
    const item = state.items.find((it) => it.id === id);
    if (item) openEditItemModal(item);
  });

  // ================= CSV(엑셀) 다운로드 =================
  function csvEscape(value) {
    const str = String(value ?? "");
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  document.getElementById("export-csv-btn").addEventListener("click", () => {
    const headers = [
      t("th_name"),
      t("th_target"),
      t("th_used"),
      t("th_in"),
      t("th_current"),
      t("th_shortage"),
      t("th_ratio"),
      t("th_status"),
    ];

    const movementIndex = buildMovementIndex();
    const rows = state.items.map((item) => {
      const s = computeItemStats(item, movementIndex);
      const statusKey = s.status === "ok" ? "status_ok" : s.status === "warn" ? "status_warn" : "status_danger";
      return [item.name, s.target, s.totalOut, s.totalIn, s.current, s.shortage, `${s.ratio}%`, t(statusKey)];
    });

    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const fname = `qlvpp-inventory-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // ---------- 입출고 일괄 등록 모달 ----------
  const movementModalOverlay = document.getElementById("movement-modal-overlay");
  const movementModalCloseBtn = document.getElementById("movement-modal-close");
  const bulkMovementTbody = document.getElementById("bulk-movement-tbody");
  const addMovementRowBtn = document.getElementById("add-movement-row-btn");
  const bulkMovementSaveBtn = document.getElementById("bulk-movement-save-btn");

  let movementRowSeq = 0;
  const movementDateFieldsMap = new Map(); // rowId -> {yyyy, mm, dd}

  function itemOptionsHtml(selectedId) {
    return state.items
      .map((it) => `<option value="${it.id}" ${it.id === selectedId ? "selected" : ""}>${escapeHtml(it.name)}</option>`)
      .join("");
  }

  function applyMovementRowPlaceholders() {
    bulkMovementTbody.querySelectorAll(".movement-recipient").forEach((el) => (el.placeholder = t("placeholder_recipient")));
    bulkMovementTbody.querySelectorAll(".movement-row-delete").forEach((el) => (el.textContent = t("delete_btn")));
    bulkMovementTbody.querySelectorAll(".movement-type-select").forEach((sel) => {
      const val = sel.value;
      sel.innerHTML = `<option value="입고">${t("in_btn")}</option><option value="출고">${t("out_btn")}</option>`;
      sel.value = val;
    });
  }

  function addMovementRow(prefill) {
    const rowId = `mrow-${++movementRowSeq}`;

    const tr = document.createElement("tr");
    tr.dataset.rowId = rowId;
    tr.innerHTML = `
      <td><select class="movement-item-select">${itemOptionsHtml(prefill && prefill.itemId)}</select></td>
      <td>
        <select class="movement-type-select">
          <option value="입고">${t("in_btn")}</option>
          <option value="출고">${t("out_btn")}</option>
        </select>
      </td>
      <td>
        <div class="date-input" data-row-date="${rowId}">
          <input type="text" inputmode="numeric" maxlength="4" class="date-yyyy" placeholder="YYYY">
          <span class="date-sep">-</span>
          <input type="text" inputmode="numeric" maxlength="2" class="date-mm" placeholder="MM">
          <span class="date-sep">-</span>
          <input type="text" inputmode="numeric" maxlength="2" class="date-dd" placeholder="DD">
        </div>
      </td>
      <td><input type="number" class="movement-qty" min="1" step="1"></td>
      <td><input type="text" class="movement-recipient" placeholder="${t("placeholder_recipient")}"></td>
      <td><button type="button" class="delete-btn movement-row-delete">${t("delete_btn")}</button></td>
    `;
    bulkMovementTbody.appendChild(tr);

    const dateContainer = tr.querySelector(`[data-row-date="${rowId}"]`);
    const dateFields = initDateInput(dateContainer);
    setDateValue(dateFields, new Date().toISOString().slice(0, 10));
    movementDateFieldsMap.set(rowId, dateFields);

    if (prefill && prefill.type) {
      // this row was opened from a specific item's 입고/출고 button, so lock
      // the 구분 to that choice — letting it be switched afterward was the
      // source of "입고를 눌렀는데 출고로 등록됐다" mistakes.
      const typeSelect = tr.querySelector(".movement-type-select");
      typeSelect.value = prefill.type;
      typeSelect.disabled = true;
    }

    tr.querySelector(".movement-row-delete").addEventListener("click", () => {
      movementDateFieldsMap.delete(rowId);
      tr.remove();
    });
  }

  function openMovementModal(prefill) {
    if (state.items.length === 0) {
      alert(t("alert_need_items_first"));
      return;
    }
    bulkMovementTbody.innerHTML = "";
    movementDateFieldsMap.clear();
    addMovementRow(prefill);
    movementModalOverlay.hidden = false;
  }

  addMovementRowBtn.addEventListener("click", () => addMovementRow());
  movementModalCloseBtn.addEventListener("click", () => {
    movementModalOverlay.hidden = true;
  });
  movementModalOverlay.addEventListener("click", (e) => {
    if (e.target === movementModalOverlay) movementModalOverlay.hidden = true;
  });

  bulkMovementSaveBtn.addEventListener("click", async () => {
    const rows = Array.from(bulkMovementTbody.querySelectorAll("tr"));
    const payload = [];
    let hasInvalidRow = false;

    rows.forEach((tr) => {
      const qtyRaw = tr.querySelector(".movement-qty").value;
      const recipient = tr.querySelector(".movement-recipient").value.trim();
      const attempted = qtyRaw !== "" || recipient !== "";
      if (!attempted) return; // silently skip a completely untouched row

      const itemId = tr.querySelector(".movement-item-select").value;
      const type = tr.querySelector(".movement-type-select").value;
      const dateFields = movementDateFieldsMap.get(tr.dataset.rowId);
      const date = getDateValue(dateFields);
      const qty = Number(qtyRaw);
      const item = state.items.find((it) => it.id === itemId);

      if (!item || !date || !qty || qty <= 0 || !recipient) {
        hasInvalidRow = true;
        return;
      }

      payload.push({
        itemId: item.id,
        itemName: item.name,
        itemUnit: item.unit,
        type,
        date,
        qty,
        recipient,
      });
    });

    if (hasInvalidRow) {
      alert(t("alert_movement_rows_invalid"));
      return;
    }

    if (payload.length === 0) {
      alert(t("alert_invalid_qty"));
      return;
    }

    if (!(await ensureConnectedOrPrompt())) return;

    bulkMovementSaveBtn.disabled = true;
    try {
      const created = await addMovementsBulk(payload);
      state.movements.unshift(...created);
      markUpdated();
      movementModalOverlay.hidden = true;
      renderInventoryTable();
      alert(t("alert_movement_added_count", { count: created.length }));
    } catch (err) {
      console.error(err);
      alert(t("alert_server_error"));
    } finally {
      bulkMovementSaveBtn.disabled = state.readOnly;
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
    renderClock();

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
