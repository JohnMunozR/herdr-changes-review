import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, focused, agents, exec, readTextFile, watchFolder, theme, settings, notify, hc, layout } from "herdr";

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const allPanes = panes();
  const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab));
  const pane = (f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null) || spacePanes.find((p) => p.cwd) || null;
  const on = pane?.machine || space?.machine || null;
  const cwd = pane?.cwd || space?.folder || null;
  return { cwd, on, spaceId: space?.id ?? null };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function getDiffColors(t) {
  const s = typeof settings === "function" ? settings() : {};
  const l = typeof layout === "function" ? layout() : {};
  const colors = {
    ...(t || {}),
    ...(s?.colors || {}),
    ...(l?.colors || {}),
  };
  const add = colors.diff_add || colors.added || colors.addition || colors.ansi2 || "#a6bd91";
  const del = colors.diff_del || colors.diff_remove || colors.removed || colors.deletion || colors.ansi1 || "#dc8c95";
  return { add, del };
}

function hexWithAlpha(color, alphaHex) {
  if (!color || typeof color !== "string") return color;
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 6) return `#${hex}${alphaHex}`;
    if (hex.length === 8) return `#${hex.slice(0, 6)}${alphaHex}`;
    if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alphaHex}`;
  }
  return color;
}

function getDiffTheme(t) {
  const { add, del } = getDiffColors(t);
  return {
    add,
    del,
    addBg: hexWithAlpha(add, "22"),
    delBg: hexWithAlpha(del, "22"),
    addHover: hexWithAlpha(add, "35"),
    delHover: hexWithAlpha(del, "35"),
  };
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

async function currentBranch(root, on) {
  const r = await exec("git", [...READ, "branch", "--show-current"], { cwd: root, on }).catch(() => null);
  if (r && r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  const h = await exec("git", [...READ, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on }).catch(() => null);
  return (h && h.code === 0 && h.stdout.trim()) ? h.stdout.trim() : "HEAD";
}

async function listCommits(root, ref, on) {
  if (!ref) return [];
  const r = await exec("git", [...READ, "log", ref, "-n", "20", "--format=%h%x09%s%x09%an%x09%cr%x09%H"], { cwd: root, on }).catch(() => null);
  if (!r || r.code !== 0) return [];
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const [shortHash, subject, author, date, hash] = line.split("\t");
    return { shortHash, subject, author, date, hash };
  });
}

export default class ChangesReview extends View {
  init(_props, cx) {
    this.files = [];
    this.rows = [];
    this.diffWidth = 0;
    this.handle = cx.focus_handle();
    this.bottomTab = "review"; // "review" | "commit"
    this.reviews = []; // Array of { file, line, text, snippet }
    this.activeComment = null; // { file, line, snippet }
    this.commentText = "";
    this.sendingReview = false;
    this.busy = false;
    this.expandedFiles = new Set();

    // Git inspection & commit viewer state
    this.viewMode = "working"; // "working" | "commit"
    this.currentBranch = "main";
    this.commits = [];
    this.selectedCommit = null;
    this.showCommitMenu = false;
    this.workingFiles = [];
    this.workingFilesCount = 0;

    // Git commit input
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typingCommit = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typingCommit = false; cx.notify(); });

    // Inline review comment textarea (wraps lines and auto-grows)
    this.commentInput = TextareaState.new({ placeholder: "Add a review note…", rows: 2 });
    this.commentInput.set_soft_wrap(true);
    this.commentInput.set_auto_grow(2, 6);
    this.commentInput.on("change", (_e, cx) => {
      const hadText = Boolean(this.commentText.trim());
      this.commentText = this.commentInput.value();
      if (hadText !== Boolean(this.commentText.trim())) cx.notify();
    });
    this.commentInput.on("submit", (_e, cx) => this.saveActiveComment(cx));
    this.commentInput.on("focus", (_e, cx) => { this.typingComment = true; cx.notify(); });
    this.commentInput.on("blur", (_e, cx) => { this.typingComment = false; cx.notify(); });

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  getComment(file, line) {
    return this.reviews.find((r) => r.file === file && r.line === line);
  }

  openCommentEditor(file, line, snippet, initialText) {
    const text = initialText ?? "";
    this.activeComment = { file, line, snippet: (snippet || "").trim() };
    this.commentText = text;
    this.commentInput.set_value(text);
    this.commentInput.set_selected_range({ start: text.length, end: text.length });
    this.commentInput.focus();
  }

  startComment(file, line, snippet, cx) {
    if (this.activeComment && this.activeComment.file === file && this.activeComment.line === line) {
      this.commentInput.focus();
      return;
    }
    const existing = this.getComment(file, line);
    this.openCommentEditor(file, line, snippet, existing ? existing.text : "");
    cx.notify();
  }

  saveActiveComment(cx) {
    if (!this.activeComment) return;
    const raw = (this.commentInput.value() ?? "").replace(/\r\n/g, "\n");
    const text = raw.trim();
    const { file, line, snippet } = this.activeComment;
    if (text) {
      const idx = this.reviews.findIndex((r) => r.file === file && r.line === line);
      if (idx >= 0) {
        this.reviews = this.reviews.map((r, i) =>
          i === idx ? { file, line, text, snippet } : r
        );
      } else {
        this.reviews = [...this.reviews, { file, line, text, snippet }];
      }
    } else {
      this.reviews = this.reviews.filter((r) => !(r.file === file && r.line === line));
    }
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  cancelActiveComment(cx) {
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  removeComment(file, line, cx) {
    this.reviews = this.reviews.filter((r) => !(r.file === file && r.line === line));
    if (this.activeComment && this.activeComment.file === file && this.activeComment.line === line) {
      this.cancelActiveComment(cx);
    } else {
      cx.notify();
    }
  }

  clearComments(cx) {
    this.reviews = [];
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  jumpToComment(comment, cx) {
    const latest = this.getComment(comment.file, comment.line) || comment;
    this.bottomTab = "review";
    if (this.open !== latest.file) {
      this.open = latest.file;
      this.closed = false;
      const context = this.context;
      cx.spawn(async (cx) => {
        try {
          await this.load(latest.file, context);
        } catch {}
        const current = this.getComment(latest.file, latest.line) || latest;
        this.openCommentEditor(current.file, current.line, current.snippet || "", current.text);
        cx.notify();
      });
    } else {
      this.openCommentEditor(latest.file, latest.line, latest.snippet || "", latest.text);
    }
    cx.notify();
  }

  findActiveAgent() {
    const f = focused();
    const all = agents();
    if (!all || all.length === 0) return null;
    if (f?.agent) {
      const m = all.find(a => a.address === f.agent);
      if (m) return m;
    }
    if (f?.tab) {
      const m = all.find(a => a.tab === f.tab);
      if (m) return m;
    }
    return all[0];
  }

  async sendReview(cx) {
    if (this.sendingReview || this.reviews.length === 0) return;
    const agent = this.findActiveAgent();
    if (!agent) {
      this.note = "No active agent found to send review notes to.";
      cx.notify();
      return;
    }
    this.sendingReview = true;
    this.note = null;
    cx.notify();

    try {
      let header = "Review comments on uncommitted changes:";
      if (this.viewMode === "commit" && this.selectedCommit) {
        header = `Review comments on commit ${this.selectedCommit.shortHash} ("${this.selectedCommit.subject}"):`;
      }
      const parts = [
        header,
        ""
      ];
      for (const r of this.reviews) {
        parts.push(`- \`${r.file}:${r.line}\`:`);
        for (const line of String(r.text || "").split(/\r?\n/)) {
          parts.push(`  ${line}`);
        }
        if (r.snippet) {
          parts.push(`  > ${r.snippet}`);
        }
        parts.push("");
      }
      const message = parts.join("\n");
      const r = await hc(["send", agent.address, message]);
      if (r.code !== 0) {
        throw new Error(r.stderr || r.stdout || "Failed to send review to agent");
      }
      notify("Review notes sent to agent");
      this.clearComments(cx);
    } catch (e) {
      this.note = `Failed to send review: ${e.message || e}`;
    } finally {
      this.sendingReview = false;
      cx.notify();
    }
  }

  switchMode(mode, target, cx) {
    this.showCommitMenu = false;
    this.viewMode = mode;
    this.note = null;
    this.error = null;

    if (mode === "working") {
      this.selectedCommit = null;
      this.files = this.workingFiles || [];
      this.open = this.files.length ? this.files[0].path : null;
      this.setLines([]);
      if (this.open) {
        const context = this.context;
        cx.spawn(async (cx) => {
          try { await this.load(this.open, context); } catch {}
          cx.notify();
        });
      }
      cx.notify();
      return;
    }

    if (mode === "commit" && target) {
      this.selectedCommit = target;
      this.loadCommitFiles(target.hash, cx);
      return;
    }

    cx.notify();
  }

  loadCommitFiles(hash, cx) {
    const root = this.root, on = this.on, context = this.context;
    if (!root || !hash) return;
    this.loading = true;
    this.files = [];
    this.setLines([]);
    this.open = null;
    this.expandedFiles.clear();
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const numResult = await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--numstat", "-z", hash]);
        const statResult = await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--name-status", "-z", hash]);
        if (numResult.code !== 0) throw new Error(numResult.stderr || "Failed to load commit stats");

        const stats = {};
        for (const entry of (numResult.stdout || "").split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          const path = parts.join("\t");
          stats[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        }

        const files = [];
        const statEntries = (statResult.stdout || "").split("\0").filter(Boolean);
        for (let i = 0; i < statEntries.length; i += 2) {
          const status = statEntries[i]?.charAt(0) || "M";
          const path = statEntries[i + 1];
          if (!path) continue;
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status, fresh: false, ...stat });
        }

        if (key() !== context) return;
        this.files = files;
        if (files.length) {
          this.open = files[0].path;
          await this.load(this.open, context);
        }
      } catch (e) {
        if (key() === context) this.error = String(e.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) {
          this.message = "";
          this.input.set_value("");
        }
      } catch (e) {
        if (key() === context) this.note = `Commit failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    const activeSpace = spaces().find((s) => s.active);
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
      this.closed = false;
      this.limited = false;
      this.expandedFiles.clear();
      this.viewMode = "working";
      this.showBranchMenu = false;
      this.showCommitMenu = false;
      this.selectedCommit = null;
      this.workingFiles = [];
      this.workingFilesCount = 0;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let root = null;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code === 0) {
          root = top.stdout.trim();
        } else if (activeSpace?.folder && activeSpace.folder !== cwd) {
          const spaceTop = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: activeSpace.folder, on }).catch(() => null);
          if (spaceTop?.code === 0) root = spaceTop.stdout.trim();
        }
        if (!root && cwd && activeSpace?.name) {
          const childTop = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: `${cwd}/${activeSpace.name}`, on }).catch(() => null);
          if (childTop?.code === 0) root = childTop.stdout.trim();
        }
        if (!root) {
          this.root = null;
          this.files = [];
          this.setLines([]);
          this.open = null;
          this.error = "Not a git repository";
          return;
        }

        const curBranch = await currentBranch(root, on);
        if (key() !== context) return;
        this.currentBranch = curBranch;
        this.commits = await listCommits(root, curBranch, on);

        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.hasHead = head.code === 0;
        this.workingFiles = files;
        this.workingFilesCount = files.length;
        this.watch(root, cx);

        if (this.viewMode === "working") {
          this.files = files;
          this.limited = entries.length > 1000;
          this.error = null;
          if (this.open && !files.some((f) => f.path === this.open)) {
            this.open = null;
            this.setLines([]);
          }
          if (!this.open && !this.closed && files.length) {
            this.open = files[0].path;
          }
          if (this.open) {
            try { await this.load(this.open, context); }
            catch { if (key() === context && this.open) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
          }
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file || !root) return;
    let lines;
    const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(path));

    if (this.viewMode === "working") {
      if (file.fresh || (!this.hasHead && file.status === "A")) {
        const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else {
          file.add = countLines(text);
          lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 450).map(l => `+${l}`)];
        }
      } else {
        const diffArgs = ["diff", ...(this.hasHead ? ["HEAD"] : []), ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
        const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
        if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
        const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
        lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
    } else if (this.viewMode === "commit" && this.selectedCommit) {
      const diffArgs = ["show", this.selectedCommit.hash, ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
      const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr || "git show failed");
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if ((key() === context || !context) && this.open === path) {
      const maxLines = isExpanded ? 800 : 350;
      let finalLines = lines || [];
      if (finalLines.length > maxLines) {
        const remaining = finalLines.length - maxLines;
        finalLines = finalLines.slice(0, maxLines);
        finalLines.push(`@@ -0,0 +0,0 @@ [Diff preview truncated: showing first ${maxLines} lines. ${remaining} more lines hidden. ${isExpanded ? "File is very large." : "Click Expand context above for more."}]`);
      }
      this.setLines(finalLines.map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) {
      cx.spawn(async (cx) => {
        try {
          await this.load(path, context);
        } catch (e) {
          if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  toggleExpand(path, cx) {
    if (!path || this.loading) return;
    if (this.expandedFiles.has(path)) {
      this.expandedFiles.delete(path);
    } else {
      this.expandedFiles.add(path);
    }
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        await this.load(path, context);
      } catch (e) {
        if (key() === context && this.open === path) {
          this.note = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
        }
      }
      cx.notify();
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t, dt, commentMap) {
    if (kind === "@") {
      const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(this.open));
      return h_flex().w_full().px(12).h(20).flex_none().items_center().justify_between()
        .bg(t.raised).border_b(1).border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleExpand(this.open, cx))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(text))
        .child(
          div().flex_none().px(5).py(0.5).rounded(3).bg(t.background).text_size(9.5).text_color(t.muted)
            .child(isExpanded ? "Collapse context" : "Expand context")
        );
    }
    const isCommentable = number !== undefined;
    const existing = (isCommentable && commentMap) ? commentMap.get(number) : null;
    const isActive = this.activeComment && this.activeComment.file === this.open && this.activeComment.line === number;
    const canSave = Boolean(this.commentText.trim());

    const isAdd = kind === "+";
    const isDel = kind === "-";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const hoverBg = isAdd ? dt.addHover : isDel ? dt.delHover : t.hover;

    const row = h_flex().w_full().h(20).flex_none().gap(10).cursor_pointer()
      .when(Boolean(rowBg), (e) => e.bg(rowBg))
      .when(Boolean(existing) || Boolean(isActive), (e) => e.bg(t.selected))
      .hover((s) => s.bg(hoverBg))
      .on_click((_e, cx) => {
        if (isCommentable) this.startComment(this.open, number, text, cx);
      })
      .child(
        div().w(30).flex_none().text_right()
          .text_color(existing || isActive ? t.foreground : diffColor || t.dim)
          .child(number === undefined ? "" : String(number))
      )
      .child(
        div().flex_1().min_w(0).truncate()
          .text_color(diffColor || t.foreground)
          .child(text)
      );

    if (!isActive && !existing) {
      return row;
    }

    return v_flex().w_full().flex_none()
      .child(row)
      .when(Boolean(isActive), (c) => c.child(
        v_flex().w_full().pl(8).pr(14).py(8).gap(6).bg(t.raised).border_b(1).border_t(1).border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            div().w_full().p(8).rounded(7).border_1().border_color(this.typingComment ? t.accent : t.border).bg(t.background).cursor_text()
              .child(Textarea.new(this.commentInput).w_full().text_size(12).text_color(t.foreground))
          )
          .child(
            h_flex().w_full().items_center().justify_between()
              .child(div().text_size(11).text_color(t.dim).child(`Line ${number}`))
              .child(
                h_flex().gap(6).items_center()
                  .child(
                    h_flex().id("inline-cancel-btn").h(26).px(10).items_center().rounded(6)
                      .border_1().border_color(t.border).bg(t.background)
                      .text_color(t.muted).text_size(11.5).cursor_pointer()
                      .hover(s => s.text_color(t.foreground))
                      .on_click((_e, cx) => this.cancelActiveComment(cx))
                      .child("Cancel")
                  )
                  .child(
                    h_flex().id("inline-save-btn").h(26).px(12).items_center().rounded(6)
                      .bg(canSave ? t.solid : t.background)
                      .text_color(canSave ? t.solid_foreground : t.dim)
                      .text_size(11.5).font_medium()
                      .when(canSave, e => e.cursor_pointer())
                      .on_click((_e, cx) => this.saveActiveComment(cx))
                      .child(existing ? "Update" : "Save")
                  )
              )
          )
      ))
      .when(!isActive && Boolean(existing), (c) => c.child(
        h_flex().w_full().pl(12).pr(16).py(6).gap(8).items_start().bg(t.raised).border_b(1).border_color(t.border).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.startComment(this.open, number, text, cx))
          .child(div().pt(2).flex_none().child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted)))
          .child(
            v_flex().flex_1().min_w(0).gap(2).children(
              String(existing.text || "").split(/\r?\n/).map((line) =>
                div().w_full().text_size(11.5).text_color(t.foreground).child(line || " ")
              )
            )
          )
          .child(
            div().p(3).rounded(4).flex_none().cursor_pointer().hover(s => s.bg(t.background))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.removeComment(this.open, number, cx);
              })
              .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.dim))
          )
      ));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), addCount = this.files.reduce((n, f) => n + f.add, 0), delCount = this.files.reduce((n, f) => n + f.del, 0);
    const dt = getDiffTheme(t);
    const { add, del } = dt;
    const commitEnabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const agent = this.findActiveAgent();
    const agentName = agent ? (agent.title || agent.app || agent.address) : null;
    const mono = settings()?.font_family ?? "JetBrains Mono";

    const commentMap = new Map();
    if (this.open && this.reviews.length > 0) {
      for (const r of this.reviews) {
        if (r.file === this.open) {
          commentMap.set(r.line, r);
        }
      }
    }

    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().relative().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.showCommitMenu) {
            this.showCommitMenu = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (this.typingComment || this.activeComment) {
            this.cancelActiveComment(cx);
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (this.typingCommit) {
            this.typingCommit = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
        }
      })
      // Header
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))

        // Commit selector dropdown button right beside "Changes" and file counter
        .child(
          h_flex().id("commit-selector-btn").h(24).px(8).gap(6).items_center().rounded(5)
            .min_w(0).max_w(220)
            .bg(this.showCommitMenu ? t.selected : t.background).border_1().border_color(this.showCommitMenu ? t.accent : t.border)
            .cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.showCommitMenu = !this.showCommitMenu;
              cx.notify();
            })
            .child(
              svg("mods/changes-review/icons/git-commit.svg")
                .size(11).flex_none()
                .text_color(this.viewMode === "working" ? t.muted : t.accent || t.foreground)
            )
            .child(
              div().flex_1().min_w(0).truncate().text_size(11).font_medium()
                .text_color(t.foreground)
                .child(
                  this.viewMode === "working"
                    ? "Working Tree"
                    : this.selectedCommit
                      ? `${this.selectedCommit.shortHash}: ${this.selectedCommit.subject}`
                      : "Select commit"
                )
            )
            .when(this.viewMode === "working" && this.workingFilesCount > 0, el => el.child(
              div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9.5).text_color(t.muted).child(String(this.workingFilesCount))
            ))
            .child(svg("mods/changes-review/icons/chevron-down.svg").size(9).flex_none().text_color(t.dim))
        )

        // Quick return to Working Tree if currently viewing a commit
        .when(this.viewMode !== "working", el => el.child(
          h_flex().id("quick-working-tree-btn").h(22).px(7).gap(4).items_center().rounded(4)
            .bg(t.background).border_1().border_color(t.border)
            .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
            .text_color(t.muted).text_size(10.5)
            .on_click((_e, cx) => {
              this.switchMode("working", null, cx);
            })
            .child("⚡ Working Tree")
            .when(this.workingFilesCount > 0, b => b.child(
              div().px(3.5).py(0.5).rounded(3).bg(t.raised).text_size(9).child(String(this.workingFilesCount))
            ))
        ))

        .child(div().flex_1())
        .child(div().text_size(11).text_color(add).child(`+${addCount}`))
        .child(div().text_size(11).text_color(del).child(`−${delCount}`)))

      // File list (changes-list)
      .child(v_flex().id("changes-list").flex_none().h(Math.min(160, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(this.open === f.path, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? add : f.status === "D" || f.status === "U" ? del : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(add).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(del).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(
        this.error || (this.loading ? "Loading changes…" : this.root ? (this.viewMode === "commit" ? "No files changed in this commit" : "No uncommitted changes") : "No folder")
      ))))
      
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      
      // Diff area
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(v_flex().id("changes-diff-lines").size_full().overflow_y_scrollbar().children(
          this.rows.map((row) => this.diffRow(row, t, dt, commentMap))
        ))
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(4).text_size(11).text_color(del).child(this.note)))
      
      // Bottom switcher bar (Review | Commit)
      .child(
        h_flex().flex_none().h(28).px(8).gap(6).items_center().border_t(1).border_color(t.border).bg(t.raised)
          .child(
            h_flex().id("tab-review").px(8).py(3).gap(5).items_center().rounded(4).text_size(11).font_medium().cursor_pointer()
              .when(this.bottomTab === "review", e => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border), e => e.text_color(t.muted).hover(s => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.bottomTab = "review"; cx.notify(); })
              .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(this.bottomTab === "review" ? t.foreground : t.muted))
              .child(div().child("Review"))
              .when(this.reviews.length > 0, el => el.child(
                div().px(4).py(0.5).rounded(3).border_1().border_color(t.border).text_color(t.muted).text_size(9.5).child(String(this.reviews.length))
              ))
          )
          .child(
            h_flex().id("tab-commit").px(8).py(3).gap(5).items_center().rounded(4).text_size(11).font_medium().cursor_pointer()
              .when(this.bottomTab === "commit", e => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border), e => e.text_color(t.muted).hover(s => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.bottomTab = "commit"; cx.notify(); })
              .child(svg("mods/changes-review/icons/git-commit.svg").size(11).text_color(this.bottomTab === "commit" ? t.foreground : t.muted))
              .child(div().child("Commit"))
          )
      )

      // Commit section (Working Tree commit input, or switch button if viewing historical commit/branch)
      .when(this.bottomTab === "commit", el => el.child(
        this.viewMode === "working"
          ? h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.background)
              .child(
                div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typingCommit ? t.accent : t.border).bg(t.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))
              )
              .child(
                div().id("commit").h(32).px(14).flex().items_center().rounded(8)
                  .bg(commitEnabled ? t.solid : t.raised)
                  .text_color(commitEnabled ? t.solid_foreground : t.dim)
                  .text_size(12)
                  .when(commitEnabled, (e) => e.cursor_pointer())
                  .on_click((_e, cx) => this.commit(cx))
                  .child(this.busy ? "Committing…" : "Commit")
              )
          : h_flex().flex_none().p(10).gap(8).items_center().justify_between().border_t(1).border_color(t.border).bg(t.background)
              .child(
                h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
                  .child(svg("mods/changes-review/icons/git-commit.svg").size(12).text_color(t.muted))
                  .child(div().child("Commits can only be made on uncommitted Working Tree changes."))
              )
              .child(
                h_flex().h(28).px(10).items_center().rounded(6).bg(t.raised).border_1().border_color(t.border)
                  .text_size(11.5).text_color(t.foreground).cursor_pointer()
                  .hover(s => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.switchMode("working", null, cx);
                  })
                  .child("Switch to Working Tree")
              )
      ))

      // Review section (scrollable list of notes + send to agent without counter)
      .when(this.bottomTab === "review", el => el.child(
        v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border).bg(t.background)
          .when(this.reviews.length === 0, h => h.child(
            div().py(6).px(4).text_size(11).text_color(t.dim).child("Click any diff line to add an inline review note.")
          ))
          .when(this.reviews.length > 0, l => l.child(
            div().w_full().h(Math.min(116, Math.max(26, this.reviews.length * 29 - 3))).flex_none().relative()
              .child(
                v_flex().id("reviews-list").size_full().overflow_y_scroll().when(this.reviews.length > 4, e => e.pr(10)).gap(3).children(
                  this.reviews.map(r => {
                    const fileName = r.file.split("/").pop();
                    const firstLine = String(r.text || "").split(/\r?\n/)[0];
                    return h_flex().id(`review-${r.file}-${r.line}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).bg(t.raised).cursor_pointer()
                      .hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.jumpToComment(r, cx))
                      .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted))
                      .child(div().text_size(11).text_color(t.muted).child(`${fileName}:${r.line}`))
                      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(firstLine))
                      .child(
                        div().p(3).rounded(4).cursor_pointer().hover(s => s.bg(t.background))
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.removeComment(r.file, r.line, cx);
                          })
                          .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.dim))
                      );
                  })
                )
              )
              .when(this.reviews.length > 4, e => e.child(
                Scrollbar.vertical("reviews-list").mode("always").absolute().top_0().bottom_0().right_0().w(6)
              ))
          ))
          .child(
            h_flex().pt(2).gap(8).items_center().justify_between()
              .child(
                h_flex().gap(4).items_center().text_size(10.5).text_color(t.dim)
                  .child(svg("mods/changes-review/icons/bot.svg").size(11).text_color(t.dim))
                  .child(div().child(agentName || "No agent active"))
              )
              .child(
                h_flex().gap(6).items_center()
                  .when(this.reviews.length > 0, el => el.child(
                    div().px(6).py(2).rounded(4).text_size(10.5).text_color(t.dim).cursor_pointer()
                      .hover(s => s.text_color(del))
                      .on_click((_e, cx) => this.clearComments(cx))
                      .child("Clear all")
                  ))
                  .child(
                    h_flex().id("send-review-btn").h(30).px(14).gap(6).items_center().rounded(8)
                      .bg(this.reviews.length > 0 && !this.sendingReview ? t.solid : t.raised)
                      .text_color(this.reviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim)
                      .text_size(12)
                      .when(this.reviews.length > 0 && !this.sendingReview, b => b.cursor_pointer().on_click((_e, cx) => this.sendReview(cx)))
                      .child(svg("mods/changes-review/icons/send.svg").size(11).text_color(this.reviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim))
                      .child(div().child(this.sendingReview ? "Sending…" : "Send to agent"))
                  )
              )
          )
      ))

      // Floating commit dropdown overlay (responsive positioning for all screen and pane sizes)
      .when(this.showCommitMenu, el => el.child(
        div().id("commit-menu-overlay").absolute().inset_0()
          .on_mouse_down("left", (_e, cx) => {
            this.showCommitMenu = false;
            cx.notify();
          })
          .child(
            v_flex().id("commit-dropdown-floating")
              .absolute().top(43).left(10).right(10).max_w(360).max_h(320)
              .rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_xl().p(4).gap(2)
              .overflow_y_scrollbar()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                h_flex().id("select-working-tree").min_h(28).py(3).flex_none().px(8).gap(7).items_center().rounded(5).cursor_pointer()
                  .when(this.viewMode === "working", s => s.bg(t.selected))
                  .hover(s => s.bg(t.hover))
                  .on_click((_e, cx) => this.switchMode("working", null, cx))
                  .child(svg("mods/changes-review/icons/git-commit.svg").size(11).flex_none().text_color(this.viewMode === "working" ? t.accent || t.foreground : t.muted))
                  .child(div().text_size(11).font_medium().child("Working Tree"))
                  .child(div().text_size(10).text_color(t.dim).child("Uncommitted"))
                  .child(div().flex_1())
                  .when(this.workingFilesCount > 0, b => b.child(
                    div().flex_none().px(4).py(0.5).rounded(3).bg(t.background).text_size(9).text_color(t.muted).child(String(this.workingFilesCount))
                  ))
              )
              .child(div().h(1).w_full().bg(t.border).my(1).flex_none())
              .children(
                this.commits.map(c => {
                  const isSelected = this.viewMode === "commit" && this.selectedCommit?.hash === c.hash;
                  return h_flex().id(`commit-item-${c.shortHash}`).min_h(34).py(3.5).flex_none().px(8).gap(7).items_center().rounded(5).cursor_pointer()
                    .when(isSelected, s => s.bg(t.selected))
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.switchMode("commit", c, cx))
                    .child(svg("mods/changes-review/icons/git-commit.svg").size(11).flex_none().text_color(isSelected ? t.accent || t.foreground : t.muted))
                    .child(
                      v_flex().flex_1().min_w(0).gap(1.5)
                        .child(
                          h_flex().gap(6).items_center()
                            .child(div().flex_none().font_family(mono).text_size(10).font_medium().text_color(isSelected ? t.foreground : t.dim).child(c.shortHash))
                            .child(div().flex_1().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(c.subject))
                        )
                        .child(
                          h_flex().gap(5).items_center().text_size(9).text_color(t.dim)
                            .child(div().truncate().child(c.author))
                            .child(div().child("·"))
                            .child(div().flex_none().child(c.date))
                        )
                    );
                })
              )
          )
      ));
  }
}
