(() => {
  "use strict";

  const ITEMS_KEY = "osm.items";
  const USAGES_KEY = "osm.usages";

  const state = {
    items: loadItems(),
    usages: loadUsages(),
    selectedItemId: null,
    searchTerm: "",
  };

  function loadItems() {
    try {
      return JSON.parse(localStorage.getItem(ITEMS_KEY)) || [];
    } catch {
      return [];
    }
  }

  function loadUsages() {
    try {
      return JSON.parse(localStorage.getItem(USAGES_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveItems() {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(state.items));
  }

  function saveUsages() {
    localStorage.setItem(USAGES_KEY, JSON.stringify(state.usages));
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  // ---------- DOM refs ----------
  const itemForm = document.getElementById("item-form");
  const itemNameInput = document.getElementById("item-name");
  const itemCategoryInput = document.getElementById("item-category");
  const itemUnitInput = document.getElementById("item-unit");
  const itemNoteInput = document.getElementById("item-note");

  const itemSearchInput = document.getElementById("item-search");
  const itemTableBody = document.getElementById("item-table-body");
  const itemEmptyMsg = document.getElementById("item-empty");

  const selectedItemInfo = document.getElementById("selected-item-info");
  const usageForm = document.getElementById("usage-form");
  const usageDateInput = document.getElementById("usage-date");
  const usageQtyInput = document.getElementById("usage-qty");
  const usageNoteInput = document.getElementById("usage-note");
  const usageSubmitBtn = document.getElementById("usage-submit");

  const usageTableBody = document.getElementById("usage-table-body");
  const usageEmptyMsg = document.getElementById("usage-empty");

  // default date = today
  usageDateInput.value = new Date().toISOString().slice(0, 10);

  // ---------- 소모품 등록 ----------
  itemForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = itemNameInput.value.trim();
    if (!name) return;

    const item = {
      id: genId(),
      name,
      category: itemCategoryInput.value.trim(),
      unit: itemUnitInput.value.trim(),
      note: itemNoteInput.value.trim(),
    };

    state.items.push(item);
    saveItems();
    itemForm.reset();
    itemNameInput.focus();
    renderItems();
  });

  // ---------- 소모품 검색 ----------
  itemSearchInput.addEventListener("input", () => {
    state.searchTerm = itemSearchInput.value.trim().toLowerCase();
    renderItems();
  });

  function getFilteredItems() {
    if (!state.searchTerm) return state.items;
    return state.items.filter((it) =>
      it.name.toLowerCase().includes(state.searchTerm) ||
      (it.category || "").toLowerCase().includes(state.searchTerm)
    );
  }

  function renderItems() {
    const filtered = getFilteredItems();
    itemTableBody.innerHTML = "";

    filtered.forEach((item) => {
      const tr = document.createElement("tr");
      if (item.id === state.selectedItemId) tr.classList.add("selected");

      const isSelected = item.id === state.selectedItemId;

      tr.innerHTML = `
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(item.note)}</td>
        <td><button type="button" class="select-btn ${isSelected ? "selected" : ""}" data-id="${item.id}">${isSelected ? "선택됨" : "선택"}</button></td>
        <td><button type="button" class="delete-btn" data-id="${item.id}">삭제</button></td>
      `;
      itemTableBody.appendChild(tr);
    });

    itemEmptyMsg.hidden = filtered.length !== 0;

    itemTableBody.querySelectorAll(".select-btn").forEach((btn) => {
      btn.addEventListener("click", () => selectItem(btn.dataset.id));
    });
    itemTableBody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteItem(btn.dataset.id));
    });
  }

  function selectItem(id) {
    state.selectedItemId = id === state.selectedItemId ? null : id;
    renderItems();
    renderSelectedInfo();
  }

  function deleteItem(id) {
    if (!confirm("이 소모품을 삭제하시겠습니까? 관련 사용 기록은 유지됩니다.")) return;
    state.items = state.items.filter((it) => it.id !== id);
    saveItems();
    if (state.selectedItemId === id) {
      state.selectedItemId = null;
      renderSelectedInfo();
    }
    renderItems();
  }

  function getSelectedItem() {
    return state.items.find((it) => it.id === state.selectedItemId) || null;
  }

  function renderSelectedInfo() {
    const item = getSelectedItem();
    if (item) {
      selectedItemInfo.textContent = `선택된 소모품: ${item.name}${item.category ? ` (${item.category})` : ""}${item.unit ? ` / 단위: ${item.unit}` : ""}`;
      selectedItemInfo.classList.add("active");
      usageSubmitBtn.disabled = false;
    } else {
      selectedItemInfo.textContent = "선택된 소모품이 없습니다. 위 목록에서 소모품을 선택해주세요.";
      selectedItemInfo.classList.remove("active");
      usageSubmitBtn.disabled = true;
    }
  }

  // ---------- 사용 기록 추가 ----------
  usageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const item = getSelectedItem();
    if (!item) return;

    const date = usageDateInput.value;
    const qty = Number(usageQtyInput.value);
    if (!date || !qty || qty <= 0) return;

    const usage = {
      id: genId(),
      itemId: item.id,
      itemName: item.name,
      itemCategory: item.category,
      itemUnit: item.unit,
      date,
      qty,
      note: usageNoteInput.value.trim(),
    };

    state.usages.unshift(usage);
    saveUsages();

    usageQtyInput.value = "";
    usageNoteInput.value = "";
    usageDateInput.value = new Date().toISOString().slice(0, 10);

    renderUsages();
  });

  function renderUsages() {
    usageTableBody.innerHTML = "";

    state.usages.forEach((usage) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(usage.date)}</td>
        <td>${escapeHtml(usage.itemName)}</td>
        <td>${escapeHtml(usage.itemCategory)}</td>
        <td>${escapeHtml(String(usage.qty))}</td>
        <td>${escapeHtml(usage.itemUnit)}</td>
        <td>${escapeHtml(usage.note)}</td>
        <td><button type="button" class="delete-btn" data-id="${usage.id}">삭제</button></td>
      `;
      usageTableBody.appendChild(tr);
    });

    usageEmptyMsg.hidden = state.usages.length !== 0;

    usageTableBody.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => deleteUsage(btn.dataset.id));
    });
  }

  function deleteUsage(id) {
    state.usages = state.usages.filter((u) => u.id !== id);
    saveUsages();
    renderUsages();
  }

  // ---------- init ----------
  renderItems();
  renderSelectedInfo();
  renderUsages();
})();
