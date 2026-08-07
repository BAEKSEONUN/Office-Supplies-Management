(() => {
  "use strict";

  const ITEMS_KEY = "osm.items";
  const MOVEMENTS_KEY = "osm.movements";
  const LEGACY_USAGES_KEY = "osm.usages";

  const state = {
    items: loadItems(),
    movements: loadMovements(),
    selectedStockItemId: null,
    stockSearchTerm: "",
    listSearchTerm: "",
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
    // migrate legacy usage-log entries (from the previous version) if present
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

  const stockDateContainer = document.querySelector('[data-date-input="stock-date"]');
  const stockDateFields = initDateInput(stockDateContainer);
  setDateValue(stockDateFields, new Date().toISOString().slice(0, 10));

  // ================= 소모품 목록 등록 (bulk) =================
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
      <td><input type="text" class="bulk-category" placeholder="분류"></td>
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

  function resetBulkRows(initialCount = 3) {
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
        category: tr.querySelector(".bulk-category").value.trim(),
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

  function filterItems(term) {
    if (!term) return state.items;
    return state.items.filter(
      (it) =>
        it.name.toLowerCase().includes(term) ||
        (it.category || "").toLowerCase().includes(term)
    );
  }

  function renderListItems() {
    const filtered = filterItems(state.listSearchTerm);
    listTbody.innerHTML = "";

    filtered.forEach((item) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${photoCellHtml(item.photo)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.category)}</td>
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
    if (state.selectedStockItemId === id) {
      state.selectedStockItemId = null;
      renderSelectedStockInfo();
    }
    renderListItems();
    renderStockItems();
  }

  // ================= 입출고 관리 =================
  const stockSearchInput = document.getElementById("stock-search");
  const stockTbody = document.getElementById("stock-item-tbody");
  const stockEmptyMsg = document.getElementById("stock-item-empty");
  const stockSelectedInfo = document.getElementById("stock-selected-info");

  const stockForm = document.getElementById("stock-form");
  const stockTypeInput = document.getElementById("stock-type");
  const stockQtyInput = document.getElementById("stock-qty");
  const stockRecipientInput = document.getElementById("stock-recipient");
  const stockSubmitBtn = document.getElementById("stock-submit");

  const stockHistoryTbody = document.getElementById("stock-history-tbody");
  const stockHistoryEmptyMsg = document.getElementById("stock-history-empty");

  stockSearchInput.addEventListener("input", () => {
    state.stockSearchTerm = stockSearchInput.value.trim().toLowerCase();
    renderStockItems();
  });

  function renderStockItems() {
    const filtered = filterItems(state.stockSearchTerm);
    stockTbody.innerHTML = "";

    filtered.forEach((item) => {
      const isSelected = item.id === state.selectedStockItemId;
      const tr = document.createElement("tr");
      if (isSelected) tr.classList.add("selected");
      tr.innerHTML = `
        <td>${photoCellHtml(item.photo)}</td>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td><button type="button" class="select-btn ${isSelected ? "selected" : ""}" data-id="${item.id}">${isSelected ? "선택됨" : "선택"}</button></td>
      `;
      stockTbody.appendChild(tr);
    });

    stockEmptyMsg.hidden = filtered.length !== 0;

    stockTbody.querySelectorAll(".select-btn").forEach((btn) => {
      btn.addEventListener("click", () => selectStockItem(btn.dataset.id));
    });
  }

  function selectStockItem(id) {
    state.selectedStockItemId = id === state.selectedStockItemId ? null : id;
    renderStockItems();
    renderSelectedStockInfo();
  }

  function getSelectedStockItem() {
    return state.items.find((it) => it.id === state.selectedStockItemId) || null;
  }

  function renderSelectedStockInfo() {
    const item = getSelectedStockItem();
    if (item) {
      stockSelectedInfo.textContent = `선택된 소모품: ${item.name}${item.category ? ` (${item.category})` : ""}${item.unit ? ` / 단위: ${item.unit}` : ""}`;
      stockSelectedInfo.classList.add("active");
      stockSubmitBtn.disabled = false;
    } else {
      stockSelectedInfo.textContent = "선택된 소모품이 없습니다. 위 목록에서 소모품을 선택해주세요.";
      stockSelectedInfo.classList.remove("active");
      stockSubmitBtn.disabled = true;
    }
  }

  stockForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const item = getSelectedStockItem();
    if (!item) return;

    const date = getDateValue(stockDateFields);
    if (!date) {
      alert("날짜를 올바르게 입력해주세요. (예: 2026-08-07)");
      return;
    }

    const qty = Number(stockQtyInput.value);
    if (!qty || qty <= 0) {
      alert("수량을 올바르게 입력해주세요.");
      return;
    }

    const recipient = stockRecipientInput.value.trim();
    if (!recipient) {
      alert("수령자를 입력해주세요.");
      return;
    }

    const movement = {
      id: genId(),
      itemId: item.id,
      itemName: item.name,
      itemCategory: item.category,
      itemUnit: item.unit,
      type: stockTypeInput.value,
      date,
      qty,
      recipient,
    };

    state.movements.unshift(movement);
    saveMovements();

    stockQtyInput.value = "";
    stockRecipientInput.value = "";
    setDateValue(stockDateFields, new Date().toISOString().slice(0, 10));

    renderStockHistory();
  });

  function renderStockHistory() {
    stockHistoryTbody.innerHTML = "";

    state.movements.forEach((m) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(m.date)}</td>
        <td>${escapeHtml(m.type)}</td>
        <td>${escapeHtml(m.itemName)}</td>
        <td>${escapeHtml(m.itemCategory)}</td>
        <td>${escapeHtml(String(m.qty))}</td>
        <td>${escapeHtml(m.itemUnit)}</td>
        <td>${escapeHtml(m.recipient)}</td>
        <td><button type="button" class="delete-btn" data-id="${m.id}">삭제</button></td>
      `;
      stockHistoryTbody.appendChild(tr);
    });

    stockHistoryEmptyMsg.hidden = state.movements.length !== 0;

    stockHistoryTbody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteMovement(btn.dataset.id));
    });
  }

  function deleteMovement(id) {
    state.movements = state.movements.filter((m) => m.id !== id);
    saveMovements();
    renderStockHistory();
  }

  // ================= init =================
  renderListItems();
  renderStockItems();
  renderSelectedStockInfo();
  renderStockHistory();
})();
