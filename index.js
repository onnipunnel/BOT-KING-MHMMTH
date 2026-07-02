import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const MAX_SIZE = 2 * 1024 * 1024 * 1024;

const SITES_FILE = "./sites.json";
const DOWNLOAD_DIR = "./downloads";

if (!BOT_TOKEN) {
  console.log("BOT_TOKEN missing");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
if (!fs.existsSync(SITES_FILE)) fs.writeFileSync(SITES_FILE, "[]");

function loadSites() {
  return JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
}

function saveSites(sites) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2));
}

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

function cleanName(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function absoluteUrl(base, link) {
  try {
    return new URL(link, base).href;
  } catch {
    return null;
  }
}

async function getHtml(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0 LegalMovieBot/1.0"
    }
  });
  return res.data;
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Welcome. Send a movie name to search.\n\nAdmin commands:\n/addsite SiteName | HomeURL | SearchURL\n/sites\n/delsite SiteName"
  );
});

bot.onText(/\/addsite (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  const parts = match[1].split("|").map(x => x.trim());

  if (parts.length < 3) {
    return bot.sendMessage(
      msg.chat.id,
      "Usage:\n/addsite SiteName | HomeURL | SearchURL\n\nExample:\n/addsite MySite | https://example.com | https://example.com/search?q={query}"
    );
  }

  const [name, homeUrl, searchUrl] = parts;

  if (!searchUrl.includes("{query}")) {
    return bot.sendMessage(msg.chat.id, "SearchURL must include {query}");
  }

  const sites = loadSites();
  sites.push({ name, homeUrl, searchUrl });
  saveSites(sites);

  bot.sendMessage(msg.chat.id, `Site added successfully:\n${name}`);
});

bot.onText(/\/sites/, (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  const sites = loadSites();

  if (!sites.length) {
    return bot.sendMessage(msg.chat.id, "No sites added.");
  }

  const text = sites
    .map((s, i) => `${i + 1}. ${s.name}\nHome: ${s.homeUrl}\nSearch: ${s.searchUrl}`)
    .join("\n\n");

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/delsite (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  const name = match[1].trim();
  const oldSites = loadSites();
  const newSites = oldSites.filter(
    s => s.name.toLowerCase() !== name.toLowerCase()
  );

  saveSites(newSites);

  bot.sendMessage(
    msg.chat.id,
    oldSites.length === newSites.length ? "Site not found." : "Site deleted successfully."
  );
});

async function searchSite(site, query) {
  const searchUrl = site.searchUrl.replace("{query}", encodeURIComponent(query));
  const html = await getHtml(searchUrl);
  const $ = cheerio.load(html);

  const q = cleanName(query);
  const results = [];

  $("a").each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href");

    if (!title || !href) return;

    if (cleanName(title).includes(q)) {
      const url = absoluteUrl(searchUrl, href);
      if (url) {
        results.push({
          site: site.name,
          title,
          url
        });
      }
    }
  });

  return results.slice(0, 10);
}

async function findDownloadLinks(pageUrl) {
  const html = await getHtml(pageUrl);
  const $ = cheerio.load(html);
  const links = [];

  $("a").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href");

    if (!href) return;

    const url = absoluteUrl(pageUrl, href);
    if (!url) return;

    const check = `${text} ${url}`.toLowerCase();

    if (
      check.includes("download") ||
      check.includes(".mp4") ||
      check.includes(".mkv")
    ) {
      let quality = "File";
      if (check.includes("480")) quality = "480p";
      if (check.includes("720")) quality = "720p";
      if (check.includes("1080")) quality = "1080p";

      links.push({ quality, url });
    }
  });

  return links.slice(0, 5);
}

async function getFileSize(url) {
  try {
    const res = await axios.head(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 LegalMovieBot/1.0"
      }
    });

    return Number(res.headers["content-length"] || 0);
  } catch {
    return 0;
  }
}

async function downloadFile(url) {
  const filename = `file_${Date.now()}.mp4`;
  const filePath = path.join(DOWNLOAD_DIR, filename);

  const res = await axios.get(url, {
    responseType: "stream",
    timeout: 0,
    headers: {
      "User-Agent": "Mozilla/5.0 LegalMovieBot/1.0"
    }
  });

  const writer = fs.createWriteStream(filePath);
  res.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return filePath;
}

const resultCache = new Map();
const qualityCache = new Map();

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || text.startsWith("/")) return;

  const sites = loadSites();

  if (!sites.length) {
    return bot.sendMessage(chatId, "No sources added yet.");
  }

  const status = await bot.sendMessage(chatId, "Searching...");

  let allResults = [];

  for (const site of sites) {
    try {
      const results = await searchSite(site, text);
      allResults.push(...results);
    } catch (e) {
      console.log("Search error:", site.name, e.message);
    }
  }

  if (!allResults.length) {
    return bot.editMessageText("No results found.", {
      chat_id: chatId,
      message_id: status.message_id
    });
  }

  allResults = allResults.slice(0, 8);
  resultCache.set(chatId, allResults);

  const keyboard = allResults.map((r, i) => [
    {
      text: `${r.title} - ${r.site}`,
      callback_data: `result_${i}`
    }
  ]);

  bot.editMessageText("Select a result:", {
    chat_id: chatId,
    message_id: status.message_id,
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("result_")) {
    const index = Number(data.replace("result_", ""));
    const selected = resultCache.get(chatId)?.[index];

    if (!selected) {
      return bot.answerCallbackQuery(query.id, { text: "Expired." });
    }

    await bot.editMessageText("Finding available files...", {
      chat_id: chatId,
      message_id: query.message.message_id
    });

    const links = await findDownloadLinks(selected.url);

    if (!links.length) {
      return bot.editMessageText("No download links found.", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }

    qualityCache.set(chatId, links);

    const keyboard = links.map((l, i) => [
      {
        text: l.quality,
        callback_data: `quality_${i}`
      }
    ]);

    return bot.editMessageText("Select quality:", {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  }

  if (data.startsWith("quality_")) {
    const index = Number(data.replace("quality_", ""));
    const selected = qualityCache.get(chatId)?.[index];

    if (!selected) {
      return bot.answerCallbackQuery(query.id, { text: "Expired." });
    }

    await bot.editMessageText("Checking file size...", {
      chat_id: chatId,
      message_id: query.message.message_id
    });

    const size = await getFileSize(selected.url);

    if (size && size > MAX_SIZE) {
      return bot.editMessageText("File is larger than 2GB. Telegram cannot send it.", {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }

    try {
      await bot.sendMessage(chatId, "Downloading file...");

      const filePath = await downloadFile(selected.url);
      const stats = fs.statSync(filePath);

      if (stats.size > MAX_SIZE) {
        fs.unlinkSync(filePath);
        return bot.sendMessage(chatId, "File is larger than 2GB.");
      }

      await bot.sendMessage(chatId, "Uploading to Telegram...");
      await bot.sendDocument(chatId, filePath);

      fs.unlinkSync(filePath);

      await bot.sendMessage(chatId, "File sent successfully.");
    } catch (e) {
      console.log("Download/upload error:", e.message);
      bot.sendMessage(chatId, "Download or upload failed.");
    }
  }
});
