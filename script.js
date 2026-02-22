// --- Constants ---
const API_BASE = '';
const HISTORY_KEY = 'rcode_history_v1';

// --- UI Elements ---
let activeSource = document.querySelector(".activeSource");
let menuIcon = document.querySelector(".menu");
let closeIcon = document.querySelector(".activeSource .close");
let themeSwitch = document.getElementById("themeSwitch");
let currentSelectionRange = null;
let userLocation = null;
let locationWatchId = null;
let selectedImageBase64 = null;

// --- Sidebar/Menu Logic ---
if (menuIcon && activeSource) {
  menuIcon.addEventListener("click", () => {
    activeSource.classList.add("active");
    menuIcon.style.display = "none";
  });
}

if (closeIcon && activeSource && menuIcon) {
  closeIcon.addEventListener("click", () => {
    activeSource.classList.remove("active");
    menuIcon.style.display = "block";
  });
}

document.addEventListener("click", (event) => {
  if (activeSource && menuIcon) {
    if (
      !activeSource.contains(event.target) &&
      !menuIcon.contains(event.target)
    ) {
      activeSource.classList.remove("active");
    }
  }
});

// --- Theme Switch Logic ---
if (themeSwitch) {
  const storageKey = "rcode-theme";
  const storedTheme = localStorage.getItem(storageKey);
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  const useLight = storedTheme ? storedTheme === "light" : prefersLight;

  if (useLight) {
    document.body.classList.add("light-mode");
    themeSwitch.setAttribute("aria-pressed", "true");
  }

  themeSwitch.addEventListener("click", () => {
    const enabled = document.body.classList.toggle("light-mode");
    localStorage.setItem(storageKey, enabled ? "light" : "dark");
    themeSwitch.setAttribute("aria-pressed", enabled ? "true" : "false");
  });
}

// --- History Management ---
function textToId(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function saveHistory(company, platform, content) {
  if (!content || content.includes("Ready to generate")) return;

  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const timestamp = new Date().toLocaleString();
  const id = textToId(company + platform + timestamp);

  if (history.length > 0 && history[0].content === content) return;

  const newItem = { id, company, platform, content, timestamp };
  history.unshift(newItem);

  if (history.length > 10) history.pop();

  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function loadHistoryItem(id) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const item = history.find(h => h.id === id);
  if (item) {
    document.getElementById('output').innerHTML = item.content;
    // Restore inputs
    document.getElementById('company').value = item.company;
    document.getElementById('platform').value = item.platform;
    document.getElementById('sources-container').innerHTML = `<p>(Source data not saved in history)</p>`;
  }
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');

  if (history.length === 0) {
    list.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-color); text-align: center; font-style: italic; padding: 10px;">No history yet.</div>`;
    return;
  }

  list.innerHTML = history.map(item => `
        <div class="media" data-id="${item.id}">
            <h3>${item.company || 'Untitled'}</h3>
            <p>${item.platform} • ${item.timestamp}</p>
        </div>
    `).join('');
}

// --- Event Listeners and Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  const generateBtn = document.getElementById('generate-btn');
  if (generateBtn) generateBtn.addEventListener('click', generateStrategy);

  const sendChatBtn = document.getElementById('send-chat-btn');
  if (sendChatBtn) sendChatBtn.addEventListener('click', sendChat);

  const chatInput = document.getElementById('chat-input');
  if (chatInput) chatInput.addEventListener('keydown', handleChatKey);

  const exportBtn = document.getElementById('export-sql-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportDatabase);

  const historyList = document.getElementById('history-list');
  if (historyList) {
    historyList.addEventListener('click', (e) => {
      const card = e.target.closest('.media');
      if (card && card.dataset.id) {
        loadHistoryItem(card.dataset.id);
      }
    });
  }

  const locationToggle = document.getElementById('location-toggle');
  if (locationToggle) {
    locationToggle.addEventListener('change', handleLocationToggle);
  }

  // Image Upload Logic
  const imageInput = document.getElementById('image-input');
  const imageUploadBtn = document.getElementById('image-upload-btn');
  const removeImageBtn = document.getElementById('remove-image-btn');

  if (imageInput) imageInput.addEventListener('change', handleImageSelect);
  if (imageUploadBtn) {
    imageUploadBtn.addEventListener('click', () => imageInput.click());
  }
  if (removeImageBtn) removeImageBtn.addEventListener('click', clearImage);

  renderHistory();
});

// --- Location Logic ---
function handleLocationToggle(e) {
  const statusDiv = document.getElementById('location-status');
  if (e.target.checked) {
    if ("geolocation" in navigator) {
      statusDiv.innerText = "Requesting permission...";
      locationWatchId = navigator.geolocation.watchPosition(
        handleLocationUpdate,
        (error) => {
          console.error("Location error:", error);
          userLocation = null;
          e.target.checked = false;
          statusDiv.innerText = "Error: Access Denied";
          statusDiv.classList.add('error');
          statusDiv.classList.remove('active');
        },
        { enableHighAccuracy: true }
      );
    } else {
      alert("Geolocation is not supported by this browser.");
      e.target.checked = false;
    }
  } else {
    if (locationWatchId) {
      navigator.geolocation.clearWatch(locationWatchId);
      locationWatchId = null;
    }
    userLocation = null;
    statusDiv.innerText = "Off";
    statusDiv.classList.remove('active', 'error');
  }
}

async function handleLocationUpdate(position) {
  const statusDiv = document.getElementById('location-status');
  const { latitude, longitude } = position.coords;

  // Update with coordinates immediately as fallback
  userLocation = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  statusDiv.innerText = `Resolving address: ${userLocation}...`;

  // Get human-readable address
  const address = await reverseGeocode(latitude, longitude);
  if (address) {
    userLocation = address;
    statusDiv.innerText = `Active: ${userLocation}`;
  } else {
    statusDiv.innerText = `Active: ${userLocation} (Address unavailable)`;
  }
  statusDiv.classList.add('active');
  statusDiv.classList.remove('error');
}

async function reverseGeocode(lat, lon) {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, {
      headers: { 'Accept-Language': 'en' }
    });
    const data = await response.json();
    if (data && data.address) {
      const a = data.address;
      // Extract precise parts: Village/Suburb, LGA/City District, State, Country
      const precise = a.village || a.suburb || a.town || a.neighbourhood || a.road || "Unknown Area";
      const lga = a.county || a.city_district || a.city || "Unknown LGA";
      const state = a.state || "";
      const country = a.country || "";

      const parts = [precise, lga, state, country].filter(Boolean);
      return parts.join(", ");
    }
  } catch (error) {
    console.error("Reverse geocoding error:", error);
  }
  return null;
}

function handleImageSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    selectedImageBase64 = event.target.result;
    document.getElementById('image-preview').src = selectedImageBase64;
    document.getElementById('image-preview-container').style.display = 'inline-block';
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  selectedImageBase64 = null;
  document.getElementById('image-input').value = "";
  document.getElementById('image-preview').src = "";
  document.getElementById('image-preview-container').style.display = 'none';
}

// --- Generation Logic ---
async function generateStrategy() {
  const outputDiv = document.getElementById("output");
  const outputCard = outputDiv.parentElement;
  const sourcesContainer = document.getElementById("sources-container");
  const btn = document.getElementById('generate-btn');
  const platform = document.getElementById('platform').value;

  const company = document.getElementById("company").value;
  const focus = document.getElementById("focus").value;
  const days = document.getElementById('days').value || "7";
  const model = document.getElementById("model").value || "gemini-2.5-flash";
  const length = document.getElementById("length").value || "Medium";

  // UI Reset
  outputCard.classList.remove('initial-state');
  outputDiv.innerHTML = "<p>Researching ecosystem (Tavily + Serper)...</p>";
  sourcesContainer.innerHTML = "<p>Researching sources...</p>";

  const badge = document.getElementById('virality-badge');
  if (badge) badge.style.display = 'none';

  if (btn) {
    btn.disabled = true;
    btn.innerText = "Generating Strategy...";
  }

  try {
    const response = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company, focus, days, platform, model, length,
        user_location: userLocation,
        image: selectedImageBase64
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let hasClearedInit = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      fullText += chunk;

      // Handle Sources
      const sourceMatch = fullText.match(/\[SOURCES_START\](.*?)\[SOURCES_END\]/s);
      if (sourceMatch) {
        const sourceData = sourceMatch[1];
        fullText = fullText.replace(sourceMatch[0], '');
        try {
          const sources = JSON.parse(sourceData);
          renderSources(sources);
        } catch (e) { console.error("Source parse error", e); }
      }

      // Handle Virality Score
      const scoreMatch = fullText.match(/\[VIRALITY_SCORE: (\d+)\]/);
      let displayText = fullText;
      if (scoreMatch) {
        const score = scoreMatch[1];
        displayText = fullText.replace(scoreMatch[0], '');
        renderScore(score);
      }

      if (!hasClearedInit && displayText.trim().length > 0) {
        outputDiv.innerHTML = "";
        hasClearedInit = true;
      }

      if (typeof marked !== 'undefined') {
        outputDiv.innerHTML = marked.parse(displayText);
      } else {
        outputDiv.textContent = displayText;
      }

      // Auto-scroll to bottom
      outputCard.scrollTop = outputCard.scrollHeight;
    }

    saveHistory(company, platform, outputDiv.innerHTML);

  } catch (err) {
    outputDiv.innerHTML += `\n<p style="color: #ef4444">Error: ${err.message}</p>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = "Initialize Strategy";
    }
  }
}

// --- Chat & Rework Logic ---
function handleChatKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    sendChat(e);
  }
}

async function sendChat(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  const outputDiv = document.getElementById('output');

  if (!message) return;

  const context = outputDiv.innerText;
  let selectionText = "";
  const selection = window.getSelection();

  if (selection.toString().length > 0 && outputDiv.contains(selection.anchorNode)) {
    selectionText = selection.toString();
    currentSelectionRange = selection.getRangeAt(0);
  }

  const payload = {
    message: message,
    context: context,
    selection: selectionText,
    model: document.getElementById('model').value,
    image: selectedImageBase64
  };

  input.value = "Thinking...";
  input.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, user_location: userLocation })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let aiText = "";

    // If rework, we'll collect the text and then apply
    // If regular chat, we can show it in a temporary overlay or the output
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      aiText += decoder.decode(value);
    }

    if (selectionText) {
      // Rework mode: automatically apply or ask?
      // For simplicity in this UI, we'll replace the selection
      applyRework(aiText);
    } else {
      // General chat: append to output or show alert?
      // Let's append to output for now
      outputDiv.innerHTML += `<hr><p><strong>Chaka:</strong> ${marked.parse(aiText)}</p>`;
    }

  } catch (error) {
    console.error("Chat Error:", error);
    alert("Error: Failed to connect to backend.");
  } finally {
    input.value = "";
    input.disabled = false;
    input.placeholder = "Ask Chaka or select text to rework...";
  }
}

function applyRework(newText) {
  if (currentSelectionRange && newText) {
    currentSelectionRange.deleteContents();
    const newNode = document.createTextNode(newText);
    currentSelectionRange.insertNode(newNode);
    window.getSelection().removeAllRanges();
    currentSelectionRange = null;

    const company = document.getElementById('company').value;
    const platform = document.getElementById('platform').value;
    saveHistory(company, platform, document.getElementById('output').innerHTML);
  }
}

// --- Source & Score Rendering ---
function renderSources(sources) {
  const container = document.getElementById("sources-container");
  container.innerHTML = "";
  if (sources.length === 0) {
    container.innerHTML = "<p>No public sources found.</p>";
    return;
  }
  sources.forEach(s => {
    const card = document.createElement("div");
    card.style.cssText = "background: var(--input-bg); border: 1px solid var(--border); padding: 12px; margin-bottom: 12px; border-radius: 8px; font-size: 0.85rem; text-align: left;";
    card.innerHTML = `
            <a href="${s.url}" target="_blank" style="color: var(--btnColor); text-decoration: none; font-weight: 700; display: block; margin-bottom: 4px;">${s.title}</a>
            <div style="font-size: 0.75rem; color: var(--text-color); opacity: 0.8;">🔗 ${new URL(s.url).hostname}</div>
        `;
    container.appendChild(card);
  });
}

function renderScore(score) {
  const badge = document.getElementById('virality-badge');
  if (!badge) return;
  badge.innerHTML = `<span style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-color);">Viral Score</span><br><strong style="font-size: 1.5rem; color: var(--btnColor);">${score}</strong>`;
  badge.style.cssText = "position: absolute; top: 20px; right: 20px; background: var(--sidebarColor); border: 1px solid var(--border); padding: 10px; border-radius: 8px; z-index: 10; text-align: center;";
  badge.style.display = 'block';
}

async function exportDatabase() {
  try {
    const response = await fetch(`${API_BASE}/export-sql`);
    if (!response.ok) throw new Error('Export failed');
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `chaka_export_${new Date().toISOString().split('T')[0]}.sql`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert("Failed to export database: " + err.message);
  }
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  renderHistory();
});
