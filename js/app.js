(() => {
  "use strict";

  const ITEMS_KEY = "osm.items";
  const MOVEMENTS_KEY = "osm.movements";
  const LEGACY_USAGES_KEY = "osm.usages";

  const state = {
    items: loadItems(),
    movements: loadMovements(),
    stockSearchTerm: "",
    listSearchTerm: "",
    modalItemId: null,
    modalType: "입고",
    historyItemId: null,
  };

  // ---------- storage ----------
  function loadItems() {
    try {
      return JSON.parse(localStorage.getItem(ITEMS_KEY)) || [];
    } catch {
      return [];
    }
  }

  function loadMovements() {
    try {
      const stored = JSON.parse(localStorage.getItem(MOVEMENTS_KEY));
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    // migrate legacy usage-log entries (from an earlier version) if present
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_USAGES_KEY));
      if (Array.isArray(legacy) && legacy.length) {
        return legacy.map((u) => ({
          id: u.id,
          itemId: u.itemId,
          itemName: u.itemName,
          itemCategory: u.itemCategory,
          itemUnit: u.itemUnit,
          type: "출고",
          date: u.date,
          qty: u.qty,
          recipient: u.note || "",
        }));
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  function saveItems() {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(state.items));
  }

  function saveMovements() {
    localStorage.setItem(MOVEMENTS_KEY, JSON.stringify(state.movements));
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      <td><input type="text" class="bulk-name" placeholder="품목명"></td>
      <td><input type="text" class="bulk-unit" placeholder="단위"></td>
      <td><input type="text" class="bulk-note" placeholder="비고"></td>
      <td><button type="button" class="delete-btn bulk-row-delete">삭제</button></td>
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

  bulkSaveBtn.addEventListener("click", () => {
    const rows = Array.from(bulkTbody.querySelectorAll("tr"));
    let addedCount = 0;

    rows.forEach((tr) => {
      const name = tr.querySelector(".bulk-name").value.trim();
      if (!name) return;

      const item = {
        id: genId(),
        name,
        unit: tr.querySelector(".bulk-unit").value.trim(),
        note: tr.querySelector(".bulk-note").value.trim(),
        photo: bulkPhotos.get(tr.dataset.rowId) || "",
      };
      state.items.push(item);
      addedCount++;
    });

    if (addedCount === 0) {
      alert("등록할 소모품의 품목명을 입력해주세요.");
      return;
    }

    saveItems();
    resetBulkRows();
    renderListItems();
    renderStockItems();
    alert(`${addedCount}개의 소모품이 등록되었습니다.`);
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
        <td><button type="button" class="delete-btn" data-id="${item.id}">삭제</button></td>
      `;
      listTbody.appendChild(tr);
    });

    listEmptyMsg.hidden = filtered.length !== 0;

    listTbody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteItem(btn.dataset.id));
    });
  }

  function deleteItem(id) {
    if (!confirm("이 소모품을 삭제하시겠습니까? 관련 입출고 내역은 유지됩니다.")) return;
    state.items = state.items.filter((it) => it.id !== id);
    saveItems();
    renderListItems();
    renderStockItems();
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
      return `<span class="consumption-none">이력 없음</span>`;
    }

    const avg = consumption.avgPerMonth;
    const isShort = currentStock < avg;
    const badge = isShort
      ? `<span class="consumption-warning">⚠ 재고 부족</span>`
      : `<span class="consumption-ok">재고 충분</span>`;

    return `
      <div class="consumption-rate">월 평균 소비량: 약 ${avg.toFixed(1)}개</div>
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
            <button type="button" class="stock-in-btn" data-id="${item.id}" data-type="입고">입고</button>
            <button type="button" class="stock-out-btn" data-id="${item.id}" data-type="출고">출고</button>
            <button type="button" class="stock-history-btn" data-id="${item.id}">이력</button>
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

  function openStockModal(itemId, type) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item) return;

    state.modalItemId = itemId;
    state.modalType = type;

    modalTitle.textContent = type === "입고" ? "입고 등록" : "출고 등록";
    modalItemName.textContent = `${item.name}${item.unit ? ` / 단위: ${item.unit}` : ""}`;
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

  modalForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const item = state.items.find((it) => it.id === state.modalItemId);
    if (!item) return;

    const date = getDateValue(modalDateFields);
    if (!date) {
      alert("날짜를 올바르게 입력해주세요. (예: 2026-08-07)");
      return;
    }

    const qty = Number(modalQtyInput.value);
    if (!qty || qty <= 0) {
      alert("수량을 올바르게 입력해주세요.");
      return;
    }

    const recipient = modalRecipientInput.value.trim();
    if (!recipient) {
      alert("수령자를 입력해주세요.");
      return;
    }

    const movement = {
      id: genId(),
      itemId: item.id,
      itemName: item.name,
      itemUnit: item.unit,
      type: state.modalType,
      date,
      qty,
      recipient,
    };

    state.movements.unshift(movement);
    saveMovements();

    closeStockModal();
    renderStockItems();
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

    historyYearSelect.innerHTML = `<option value="">전체</option>`;
    for (let y = HISTORY_START_YEAR; y <= lastYear; y++) {
      historyYearSelect.insertAdjacentHTML("beforeend", `<option value="${y}">${y}년</option>`);
    }

    historyMonthSelect.innerHTML = `<option value="">전체</option>`;
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      historyMonthSelect.insertAdjacentHTML("beforeend", `<option value="${mm}">${m}월</option>`);
    }
  }

  populateHistoryFilters();

  function openHistoryModal(itemId) {
    const item = state.items.find((it) => it.id === itemId);
    if (!item) return;

    state.historyItemId = itemId;
    historyModalTitle.textContent = `${item.name} 입출고 이력`;
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
  renderListItems();
  renderStockItems();
})();
