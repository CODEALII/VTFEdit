import { useDeferredValue, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import "./App.css";
import {
  cloneDraft,
  defaultDraft,
  findMaterialsRoot,
  getDirectory,
  parseVmt,
  serializeVmt,
  toMaterialReference,
  type EntryNode,
  type MaterialDraft,
} from "./lib/vmt";

type EditorView = "material" | "effects" | "code";
type MenuId = "file" | "edit";

type TexturePreview = {
  dataUrl: string;
  fileName: string;
  path: string;
  sourceType: string;
  width: number;
  height: number;
  vtfFormat?: string | null;
  vtfVersion?: string | null;
  mipmaps?: number | null;
  frames?: number | null;
  frameIndex?: number | null;
};

type PreviewState = "idle" | "loading" | "ready" | "error";

type OpenedSnapshot = {
  draft: MaterialDraft;
  currentFile: string | null;
  sourceTexturePath: string | null;
  materialsRoot: string | null;
  dirty: boolean;
  previewFrame: number;
};

const appWindow = getCurrentWindow();

const shaderOptions = ["VertexLitGeneric", "UnlitGeneric", "LightmappedGeneric", "Refract"];

const toggleFields: Array<[label: string, key: keyof MaterialDraft]> = [
  ["Model", "model"],
  ["Translucent", "translucent"],
  ["Alpha Test", "alphatest"],
  ["Additive", "additive"],
  ["Self Illum", "selfillum"],
  ["Wireframe", "wireframe"],
  ["Vertex Color", "vertexcolor"],
  ["No LOD", "nolod"],
  ["No Fog", "nofog"],
  ["No Cull", "nocull"],
  ["Ignore Z", "ignorez"],
  ["No Fullbright", "noFullbright"],
  ["Phong", "phong"],
];

const viewItems: Array<{ id: EditorView; title: string }> = [
  { id: "material", title: "Material" },
  { id: "effects", title: "Advanced" },
  { id: "code", title: "Code" },
];

const stylePresets = [
  {
    name: "Standard",
    description: "Clean default model material.",
    apply: (draft: MaterialDraft) => {
      draft.shader = "VertexLitGeneric";
      draft.model = true;
      draft.translucent = false;
      draft.alphatest = false;
      draft.additive = false;
      draft.selfillum = false;
      draft.wireframe = false;
    },
  },
  {
    name: "Hologram",
    description: "Sharper unlit look with alpha test.",
    apply: (draft: MaterialDraft) => {
      draft.shader = "UnlitGeneric";
      draft.alphatest = true;
      draft.nofog = true;
      draft.nolod = true;
      draft.wireframe = false;
    },
  },
  {
    name: "Reflective",
    description: "Envmap focus with a soft pulse.",
    apply: (draft: MaterialDraft) => {
      draft.shader = "VertexLitGeneric";
      draft.envmapContrast = 1;
      draft.envmapSaturation = 0.9;
      draft.pulseEnabled = true;
      draft.pulseTarget = "$envmapcontrast";
      draft.pulseMin = 0;
      draft.pulseMax = 1.1;
      draft.pulsePeriod = 2.5;
    },
  },
  {
    name: "Scroll Glow",
    description: "Detail scroll with alpha pulse.",
    apply: (draft: MaterialDraft) => {
      draft.shader = "VertexLitGeneric";
      draft.detailTexture = draft.detailTexture || "effects/combinemuzzle2";
      draft.detailScrollEnabled = true;
      draft.detailScrollRate = 0.1;
      draft.detailScrollAngle = 90;
      draft.pulseEnabled = true;
      draft.pulseTarget = "$alpha";
      draft.pulseMin = 0.75;
      draft.pulseMax = 1.15;
      draft.pulsePeriod = 1.6;
    },
  },
];

function App() {
  const [draft, setDraft] = useState<MaterialDraft>(defaultDraft());
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [sourceTexturePath, setSourceTexturePath] = useState<string | null>(null);
  const [materialsRoot, setMaterialsRoot] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<EditorView>("material");
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const [basePreview, setBasePreview] = useState<TexturePreview | null>(null);
  const [detailPreview, setDetailPreview] = useState<TexturePreview | null>(null);
  const [basePreviewState, setBasePreviewState] = useState<PreviewState>("idle");
  const [detailPreviewState, setDetailPreviewState] = useState<PreviewState>("idle");
  const [activeMenu, setActiveMenu] = useState<MenuId | null>(null);
  const [previewFrame, setPreviewFrame] = useState(0);
  const [openedSnapshot, setOpenedSnapshot] = useState<OpenedSnapshot | null>(null);
  const [previewMotionTime, setPreviewMotionTime] = useState(() => Date.now());
  const [codeDraft, setCodeDraft] = useState(() => serializeVmt(defaultDraft()));
  const [codeError, setCodeError] = useState<string | null>(null);

  const preview = serializeVmt(draft);
  const previewContextPath = currentFile ?? sourceTexturePath;
  const isTextureDraft = !currentFile && Boolean(sourceTexturePath);
  const deferredBaseTexture = useDeferredValue(draft.baseTexture);
  const deferredDetailTexture = useDeferredValue(draft.detailTexture);
  const fileName = getDocumentName(currentFile, sourceTexturePath);
  const filePathLabel = currentFile ?? sourceTexturePath ?? "No file opened yet";
  const defaultSaveName = getDefaultSaveName(currentFile, sourceTexturePath);
  const preservedEntries = draft.extraNodes.length;
  const preservedProxies = draft.extraProxyNodes.length;
  const frameCount = Math.max(basePreview?.frames ?? 1, 1);
  const activeFrame = basePreview?.frameIndex ?? previewFrame;
  const effectivePreviewFps = frameCount > 1 ? clamp(draft.animatedFps || 15, 1, 60) : 0;
  const frameLabel =
    basePreview?.sourceType === "vtf" && frameCount > 1 ? `Frame ${activeFrame + 1}/${frameCount}` : basePreview?.sourceType?.toUpperCase() ?? "Preview";
  const statusTone = status.toLowerCase().includes("failed") || status.toLowerCase().includes("unavailable") ? "error" : "neutral";
  const pulseSample = draft.pulseEnabled ? samplePulse(previewMotionTime / 1000, draft.pulseMin, draft.pulseMax, draft.pulsePeriod) : null;
  const liveAlpha = draft.pulseEnabled && draft.pulseTarget.toLowerCase() === "$alpha" && pulseSample != null ? pulseSample : draft.alpha;
  const liveEnvmapContrast =
    draft.pulseEnabled && draft.pulseTarget.toLowerCase() === "$envmapcontrast" && pulseSample != null ? pulseSample : draft.envmapContrast;
  const baseTransform = buildScrollTransform(draft.baseScrollEnabled, draft.baseScrollRate, draft.baseScrollAngle, previewMotionTime / 1000);
  const detailTransform = buildScrollTransform(draft.detailScrollEnabled, draft.detailScrollRate, draft.detailScrollAngle, previewMotionTime / 1000);
  const tintActive = normalizeHexColor(draft.colorTint) !== "#ffffff";
  const unknownEntryKeys = collectUnknownEntryKeys(draft.extraNodes);
  const unknownProxyKeys = collectUnknownEntryKeys(draft.extraProxyNodes);
  const hasUnknownKeys = unknownEntryKeys.length > 0 || unknownProxyKeys.length > 0;

  useEffect(() => {
    const setupWindowState = async () => {
      setIsMaximized(await appWindow.isMaximized());
      setIsFocused(await appWindow.isFocused());

      const unlistenResize = await appWindow.onResized(async () => {
        setIsMaximized(await appWindow.isMaximized());
      });
      const unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
        setIsFocused(payload);
      });

      return () => {
        unlistenResize();
        unlistenFocus();
      };
    };

    let cleanup: (() => void) | undefined;
    void setupWindowState().then((dispose) => {
      cleanup = dispose;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const loadStartupFile = async () => {
      const startupFile = await invoke<string | null>("get_startup_file");
      if (startupFile) {
        await openDocument(startupFile);
      }
    };

    void loadStartupFile();
  }, []);

  useEffect(() => {
    if (view === "code") return;
    setCodeDraft(preview);
  }, [preview, view]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".titlebar-menu")) {
        setActiveMenu(null);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveMenu(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (status === "Ready") return;

    const timeout = window.setTimeout(() => {
      setStatus("Ready");
    }, statusTone === "error" ? 5000 : 2200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [status, statusTone]);

  useEffect(() => {
    let cancelled = false;

    async function loadBasePreview() {
      if (!deferredBaseTexture.trim()) {
        setBasePreview(null);
        setBasePreviewState("idle");
        return;
      }

      setBasePreviewState("loading");

      try {
        const resolved = await invoke<TexturePreview | null>("load_texture_preview", {
          reference: deferredBaseTexture,
          materialsRoot,
          contextPath: previewContextPath,
          frame: previewFrame,
        });

        if (cancelled) return;
        setBasePreview(resolved);
        setBasePreviewState(resolved ? "ready" : "error");
      } catch {
        if (cancelled) return;
        setBasePreview(null);
        setBasePreviewState("error");
      }
    }

    void loadBasePreview();

    return () => {
      cancelled = true;
    };
  }, [deferredBaseTexture, materialsRoot, previewContextPath, previewFrame]);

  useEffect(() => {
    setPreviewFrame(0);
  }, [deferredBaseTexture, previewContextPath]);

  useEffect(() => {
    if (!basePreview?.frames) return;
    if (previewFrame < basePreview.frames) return;
    setPreviewFrame(Math.max(basePreview.frames - 1, 0));
  }, [basePreview, previewFrame]);

  useEffect(() => {
    if (effectivePreviewFps <= 0) return;

    const interval = window.setInterval(() => {
      setPreviewFrame((current) => (current + 1) % frameCount);
    }, Math.max(16, Math.round(1000 / effectivePreviewFps)));

    return () => {
      window.clearInterval(interval);
    };
  }, [frameCount, effectivePreviewFps]);

  useEffect(() => {
    const hasLiveMotion = draft.pulseEnabled || draft.baseScrollEnabled || draft.detailScrollEnabled;
    if (!hasLiveMotion) return;

    const interval = window.setInterval(() => {
      setPreviewMotionTime(Date.now());
    }, 33);

    return () => {
      window.clearInterval(interval);
    };
  }, [draft.pulseEnabled, draft.baseScrollEnabled, draft.detailScrollEnabled]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetailPreview() {
      if (!deferredDetailTexture.trim()) {
        setDetailPreview(null);
        setDetailPreviewState("idle");
        return;
      }

      setDetailPreviewState("loading");

      try {
        const resolved = await invoke<TexturePreview | null>("load_texture_preview", {
          reference: deferredDetailTexture,
          materialsRoot,
          contextPath: previewContextPath,
        });

        if (cancelled) return;
        setDetailPreview(resolved);
        setDetailPreviewState(resolved ? "ready" : "error");
      } catch {
        if (cancelled) return;
        setDetailPreview(null);
        setDetailPreviewState("error");
      }
    }

    void loadDetailPreview();

    return () => {
      cancelled = true;
    };
  }, [deferredDetailTexture, materialsRoot, previewContextPath]);

  async function openDocument(path: string) {
    if (isTextureSource(path)) {
      const root = findMaterialsRoot(path);
      const nextDraft = defaultDraft();
      nextDraft.shader = "VertexLitGeneric";
      nextDraft.model = true;
      nextDraft.baseTexture = toMaterialReference(path, root);
      nextDraft.presentKeys.add("$basetexture");
      nextDraft.presentKeys.add("$model");

      setDraft(nextDraft);
      setCurrentFile(null);
      setSourceTexturePath(path);
      setMaterialsRoot(root);
      setDirty(true);
      setPreviewFrame(0);
      setOpenedSnapshot({
        draft: cloneDraft(nextDraft),
        currentFile: null,
        sourceTexturePath: path,
        materialsRoot: root,
        dirty: true,
        previewFrame: 0,
      });
      setCodeDraft(serializeVmt(nextDraft));
      setCodeError(null);
      setStatus("Texture loaded");
      return;
    }

    try {
      const content = await invoke<string>("read_text_file", { path });
      const parsed = parseVmt(content);
      const root = findMaterialsRoot(path);
      setDraft(parsed);
      setCurrentFile(path);
      setSourceTexturePath(null);
      setMaterialsRoot(root);
      setDirty(false);
      setPreviewFrame(0);
      setOpenedSnapshot({
        draft: cloneDraft(parsed),
        currentFile: path,
        sourceTexturePath: null,
        materialsRoot: root,
        dirty: false,
        previewFrame: 0,
      });
      setCodeDraft(serializeVmt(parsed));
      setCodeError(null);
      setStatus(`Loaded ${path.split(/[/\\]/).pop()}`);
    } catch (error) {
      setStatus(`Open failed: ${String(error)}`);
    }
  }

  async function handleOpenFile() {
    const selected = await invoke<string | null>("open_vmt_dialog", {
      directory: getDirectory(previewContextPath),
    });

    if (selected) {
      await openDocument(selected);
    }
  }

  async function saveToFile(path: string) {
    try {
      await invoke("write_text_file", { path, contents: preview });
      setCurrentFile(path);
      setMaterialsRoot(findMaterialsRoot(path) ?? materialsRoot ?? findMaterialsRoot(sourceTexturePath));
      setDirty(false);
      setStatus(`Saved ${path.split(/[/\\]/).pop()}`);
    } catch (error) {
      setStatus(`Save failed: ${String(error)}`);
    }
  }

  async function handleSave() {
    let target = currentFile;

    if (!target) {
      target = await invoke<string | null>("save_vmt_dialog", {
        directory: getDirectory(previewContextPath),
        fileName: defaultSaveName,
      });
      if (!target) return;
    }

    await saveToFile(target);
  }

  async function handleSaveAs() {
    const target = await invoke<string | null>("save_vmt_dialog", {
      directory: getDirectory(previewContextPath),
      fileName: defaultSaveName,
    });

    if (!target) return;
    await saveToFile(target);
  }

  function handleRestoreOpenedState() {
    if (!openedSnapshot) {
      setStatus("No opened state available.");
      return;
    }

    setDraft(cloneDraft(openedSnapshot.draft));
    setCurrentFile(openedSnapshot.currentFile);
    setSourceTexturePath(openedSnapshot.sourceTexturePath);
    setMaterialsRoot(openedSnapshot.materialsRoot);
    setDirty(openedSnapshot.dirty);
    setPreviewFrame(openedSnapshot.previewFrame);
    setCodeDraft(serializeVmt(openedSnapshot.draft));
    setCodeError(null);
    setStatus("Restored");
  }

  async function handleTexturePick(field: "baseTexture" | "detailTexture" | "envmapTexture") {
    const selected = await invoke<string | null>("open_texture_dialog", {
      directory: materialsRoot ?? getDirectory(previewContextPath),
    });

    if (!selected) return;

    updateDraft((next) => {
      next[field] = toMaterialReference(selected, materialsRoot);
      if (field === "baseTexture" && !next[field]) next.presentKeys.delete("$basetexture");
      if (field === "detailTexture" && !next[field]) next.presentKeys.delete("$detail");
      if (field === "envmapTexture" && !next[field]) next.presentKeys.delete("$envmap");
    });
    if (field === "baseTexture") {
      setPreviewFrame(0);
    }
    if (!sourceTexturePath && field === "baseTexture") {
      setSourceTexturePath(selected);
    }
  }

  function updateDraft(mutator: (next: MaterialDraft) => void) {
    setDraft((current) => {
      const next = cloneDraft(current);
      mutator(next);
      return next;
    });
    setDirty(true);
  }

  function updateText(
    key: "shader" | "surfaceprop" | "baseTexture" | "detailTexture" | "envmapTexture",
    value: string,
  ) {
    updateDraft((next) => {
      next[key] = value;
      if (key === "baseTexture" && value) next.presentKeys.add("$basetexture");
      if (key === "detailTexture" && value) next.presentKeys.add("$detail");
      if (key === "envmapTexture" && value) next.presentKeys.add("$envmap");
      if (key === "surfaceprop" && value) next.presentKeys.add("$surfaceprop");
      if (key === "baseTexture" && !value) next.presentKeys.delete("$basetexture");
      if (key === "detailTexture" && !value) next.presentKeys.delete("$detail");
      if (key === "envmapTexture" && !value) next.presentKeys.delete("$envmap");
      if (key === "surfaceprop" && !value) next.presentKeys.delete("$surfaceprop");
    });
  }

  function updateNumber(key: keyof MaterialDraft, value: number) {
    updateDraft((next) => {
      (next[key] as number) = value;
    });
  }

  function updateBoolean(key: keyof MaterialDraft, value: boolean) {
    updateDraft((next) => {
      (next[key] as boolean) = value;
    });
  }

  function updateColorTint(value: string) {
    const normalized = normalizeHexColor(value);
    updateDraft((next) => {
      next.colorTint = normalized;
      if (normalized !== "#ffffff" || next.presentKeys.has("$color")) {
        next.presentKeys.add("$color");
      }
    });
  }

  function applyPreset(name: string) {
    updateDraft((next) => {
      stylePresets.find((preset) => preset.name === name)?.apply(next);
    });
      setStatus(`${name} preset`);
  }

  function handleCodeChange(value: string) {
    setCodeDraft(value);

    try {
      const parsed = parseVmt(value);
      setDraft(parsed);
      setDirty(true);
      setCodeError(null);
    } catch (error) {
      setCodeError(error instanceof Error ? error.message : "Invalid VMT syntax.");
    }
  }

  async function copyToClipboard(value: string, label: string) {
    if (!value.trim()) {
      setStatus(`No ${label.toLowerCase()} available.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setStatus(`${label} copied.`);
    } catch {
      setStatus("Clipboard copy failed.");
    }
  }

  function toggleMenu(menu: MenuId) {
    setActiveMenu((current) => (current === menu ? null : menu));
  }

  function runMenuAction(action: () => void | Promise<void>) {
    setActiveMenu(null);
    void Promise.resolve(action()).catch(() => {
      setStatus("Menu action failed.");
    });
  }

  const titleMenus: Array<{
    id: MenuId;
    label: string;
    items: Array<{ label: string; active?: boolean; action: () => void | Promise<void> }>;
  }> = [
    {
      id: "file",
      label: "File",
      items: [
        { label: "Open...", action: handleOpenFile },
        { label: "Save", action: handleSave },
        { label: "Save As...", action: handleSaveAs },
        { label: "Close App", action: handleClose },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { label: "Copy VMT Code", action: () => copyToClipboard(preview, "VMT code") },
        { label: "Copy Base Texture Path", action: () => copyToClipboard(draft.baseTexture, "Base texture path") },
        { label: "Apply Standard Preset", action: () => applyPreset("Standard") },
      ],
    },
  ];

  function handleMinimize() {
    void appWindow.minimize().catch(() => {
      setStatus("Window minimize failed.");
    });
  }

  function handleMaximize() {
    void appWindow
      .toggleMaximize()
      .then(async () => {
        setIsMaximized(await appWindow.isMaximized());
      })
      .catch(() => {
        setStatus("Window maximize failed.");
      });
  }

  function handleClose() {
    void appWindow.close().catch(() => {
      setStatus("Window close failed.");
    });
  }

  function handleDragStart(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (isNonDraggableTarget(target)) return;

    void appWindow.startDragging().catch(() => {
      setStatus("Window drag failed.");
    });
  }

  function handleTitlebarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (isNonDraggableTarget(target)) return;
    handleMaximize();
  }

  return (
    <main className={isFocused ? "app-shell focused" : "app-shell"}>
      <header className="titlebar" onMouseDown={handleDragStart} onDoubleClick={handleTitlebarDoubleClick}>
        <div className="titlebar-left">
          <div className="titlebar-brand">
            <div className="brand-mark">+</div>
            <span className="brand-name">VTFEdit+</span>
          </div>

          <nav className="titlebar-menu" aria-label="Application menu" data-no-drag="true">
            {titleMenus.map((menu) => (
              <div key={menu.id} className="titlebar-menu-wrap" data-no-drag="true">
                <button
                  type="button"
                  className={activeMenu === menu.id ? "titlebar-menu-button active" : "titlebar-menu-button"}
                  aria-expanded={activeMenu === menu.id}
                  onClick={() => toggleMenu(menu.id)}
                >
                  {menu.label}
                </button>

                {activeMenu === menu.id ? (
                  <div className="titlebar-menu-popover">
                    {menu.items.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className={item.active ? "titlebar-menu-action active" : "titlebar-menu-action"}
                        onClick={() => runMenuAction(item.action)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </nav>
        </div>

        <div className="titlebar-center">
          <span className="window-doc">{fileName}</span>
        </div>

        <div className="titlebar-right" data-no-drag="true">
          <span className={dirty ? "window-pill dirty" : "window-pill"}>{dirty ? "Unsaved" : "Saved"}</span>

          <div className="window-controls">
            <button className="window-btn" type="button" onClick={handleMinimize} aria-label="Minimize" data-no-drag="true">
              -
            </button>
            <button className="window-btn" type="button" onClick={handleMaximize} aria-label="Maximize" data-no-drag="true">
              {isMaximized ? "❐" : "□"}
            </button>
            <button className="window-btn close" type="button" onClick={handleClose} aria-label="Close" data-no-drag="true">
              ×
            </button>
          </div>
        </div>
      </header>

      <div className="workspace-shell">
        <aside className="sidebar">
          <section className="sidebar-panel brand-panel">
            <p className="sidebar-overline">Workspace</p>
            <h1>VTFEdit+</h1>
            <p className="sidebar-copy">Texture and material editor</p>
          </section>

          <section className="sidebar-panel">
            <p className="sidebar-label">File</p>
            <button className="sidebar-file" type="button" onClick={handleOpenFile} title="Open a .vmt or .vtf file">
              <strong>{previewContextPath ? fileName : "Open VMT or VTF"}</strong>
              <span>{filePathLabel}</span>
            </button>
          </section>

          <section className="sidebar-panel">
            <p className="sidebar-label">Sections</p>
            <div className="sidebar-list">
              {viewItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={view === item.id ? "sidebar-list-item active" : "sidebar-list-item"}
                  onClick={() => setView(item.id)}
                  title={`Open the ${item.title.toLowerCase()} section`}
                >
                  <strong>{item.title}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="sidebar-panel">
            <p className="sidebar-label">Presets</p>
            <div className="sidebar-list">
              {stylePresets.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="sidebar-list-item"
                  onClick={() => applyPreset(preset.name)}
                  title={`${preset.name}: ${preset.description}`}
                >
                  <strong>{preset.name}</strong>
                  <span>{preset.description}</span>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="main-pane">
          <div className="main-layout">
            <div className="editor-frame">
            <section className="hero-panel">
              <div className="hero-copy">
                <h2>{fileName}</h2>
                <p className="hero-path" title={filePathLabel}>
                  {filePathLabel}
                </p>
              </div>

              <div className="hero-actions">
                <button type="button" className="toolbar-btn" onClick={handleOpenFile} title="Open a .vmt or .vtf file">
                  Open
                </button>
                <button type="button" className="toolbar-btn primary" onClick={handleSave} title="Save the current material">
                  Save
                </button>
                <button type="button" className="toolbar-btn" onClick={handleSaveAs} title="Save to a new .vmt file">
                  Save As
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={handleRestoreOpenedState}
                  disabled={!openedSnapshot}
                  title="Restore the file state from when it was opened"
                >
                  Restore
                </button>
              </div>
            </section>

            {status !== "Ready" ? (
              <section className={statusTone === "error" ? "statusline error" : "statusline"}>{status}</section>
            ) : null}

            {view === "material" && (
              <div className="editor-grid">
                <article className="panel panel-wide">
                  <div className="panel-head">
                    <div>
                      <p className="section-label">Material</p>
                      <h3>Main settings</h3>
                    </div>
                  </div>

                  <div className="field-grid">
                    <label className="field-group">
                      <span>Shader</span>
                      <select value={draft.shader} onChange={(event) => updateText("shader", event.target.value)} title="Choose the Source shader">
                        {shaderOptions.map((shader) => (
                          <option key={shader} value={shader}>
                            {shader}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field-group">
                      <span>Surface</span>
                      <input
                        value={draft.surfaceprop}
                        onChange={(event) => updateText("surfaceprop", event.target.value)}
                        placeholder="metal, glass, concrete..."
                        title="Surface property used for sounds and impact behavior"
                      />
                    </label>

                    <label className="field-group">
                      <span>Tint</span>
                      <div className="color-input-row" title="Change the material color tint">
                        <input
                          className="color-swatch"
                          type="color"
                          value={normalizeHexColor(draft.colorTint)}
                          onChange={(event) => updateColorTint(event.target.value)}
                        />
                        <input
                          value={normalizeHexColor(draft.colorTint)}
                          onChange={(event) => updateColorTint(event.target.value)}
                          placeholder="#ffffff"
                          title="Hex color tint"
                        />
                      </div>
                    </label>

                    <label className="field-group full-span">
                      <span>Base texture</span>
                      <div className="field-action">
                        <input
                          value={draft.baseTexture}
                          onChange={(event) => updateText("baseTexture", event.target.value)}
                          placeholder="models/.../texture"
                          title="Base texture material path"
                        />
                        <button type="button" className="inline-btn" onClick={() => handleTexturePick("baseTexture")} title="Pick the base texture file">
                          Browse
                        </button>
                      </div>
                    </label>

                    <label className="field-group">
                      <span>Detail</span>
                      <div className="field-action">
                        <input
                          value={draft.detailTexture}
                          onChange={(event) => updateText("detailTexture", event.target.value)}
                          placeholder="effects/..."
                          title="Optional detail texture path"
                        />
                        <button type="button" className="inline-btn" onClick={() => handleTexturePick("detailTexture")} title="Pick the detail texture file">
                          Browse
                        </button>
                      </div>
                    </label>

                    <label className="field-group">
                      <span>Envmap</span>
                      <div className="field-action">
                        <input
                          value={draft.envmapTexture}
                          onChange={(event) => updateText("envmapTexture", event.target.value)}
                          placeholder="models/.../envmap"
                          title="Optional envmap texture path"
                        />
                        <button type="button" className="inline-btn" onClick={() => handleTexturePick("envmapTexture")} title="Pick the envmap texture file">
                          Browse
                        </button>
                      </div>
                    </label>
                  </div>
                </article>

                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <p className="section-label">Flags</p>
                      <h3>Flags</h3>
                    </div>
                  </div>

                  <div className="toggle-grid">
                    {toggleFields.map(([label, key]) => (
                      <button
                        key={label}
                        type="button"
                        className={draft[key] ? "toggle active" : "toggle"}
                        onClick={() => updateBoolean(key, !draft[key])}
                        title={`Toggle ${label}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </article>
              </div>
            )}

            {view === "effects" && (
              <div className="editor-grid">
                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <p className="section-label">Adjustments</p>
                      <h3>Fine tuning</h3>
                    </div>
                  </div>

                  <div className="slider-list">
                    <RangeRow label="Alpha" min={0} max={1} step={0.01} value={draft.alpha} onChange={(value) => updateNumber("alpha", value)} />
                    <RangeRow
                      label="Detail scale"
                      min={0}
                      max={8}
                      step={0.05}
                      value={draft.detailScale}
                      onChange={(value) => updateNumber("detailScale", value)}
                    />
                    <RangeRow
                      label="Envmap contrast"
                      min={0}
                      max={3}
                      step={0.05}
                      value={draft.envmapContrast}
                      onChange={(value) => updateNumber("envmapContrast", value)}
                    />
                    <RangeRow
                      label="Envmap saturation"
                      min={0}
                      max={3}
                      step={0.05}
                      value={draft.envmapSaturation}
                      onChange={(value) => updateNumber("envmapSaturation", value)}
                    />
                    <RangeRow
                      label="Detail blend mode"
                      min={0}
                      max={10}
                      step={1}
                      value={draft.detailBlendMode}
                      onChange={(value) => updateNumber("detailBlendMode", value)}
                    />
                  </div>
                </article>

                <article className="panel">
                  <div className="panel-head">
                    <div>
                      <p className="section-label">Animation</p>
                      <h3>Proxy blocks</h3>
                    </div>
                  </div>

                  <div className="proxy-grid">
                    <ProxyBox title="Animated texture" enabled={draft.animatedEnabled} onToggle={() => updateBoolean("animatedEnabled", !draft.animatedEnabled)}>
                      <RangeRow
                        label="FPS"
                        min={1}
                        max={60}
                        step={1}
                        value={draft.animatedFps}
                        onChange={(value) => updateNumber("animatedFps", value)}
                        compact
                      />
                    </ProxyBox>

                    <ProxyBox title="Base scroll" enabled={draft.baseScrollEnabled} onToggle={() => updateBoolean("baseScrollEnabled", !draft.baseScrollEnabled)}>
                      <RangeRow
                        label="Speed"
                        min={0}
                        max={3}
                        step={0.01}
                        value={draft.baseScrollRate}
                        onChange={(value) => updateNumber("baseScrollRate", value)}
                        compact
                      />
                      <RangeRow
                        label="Angle"
                        min={0}
                        max={360}
                        step={1}
                        value={draft.baseScrollAngle}
                        onChange={(value) => updateNumber("baseScrollAngle", value)}
                        compact
                      />
                    </ProxyBox>

                    <ProxyBox
                      title="Detail scroll"
                      enabled={draft.detailScrollEnabled}
                      onToggle={() => updateBoolean("detailScrollEnabled", !draft.detailScrollEnabled)}
                    >
                      <RangeRow
                        label="Speed"
                        min={0}
                        max={3}
                        step={0.01}
                        value={draft.detailScrollRate}
                        onChange={(value) => updateNumber("detailScrollRate", value)}
                        compact
                      />
                      <RangeRow
                        label="Angle"
                        min={0}
                        max={360}
                        step={1}
                        value={draft.detailScrollAngle}
                        onChange={(value) => updateNumber("detailScrollAngle", value)}
                        compact
                      />
                    </ProxyBox>

                    <ProxyBox title="Pulse" enabled={draft.pulseEnabled} onToggle={() => updateBoolean("pulseEnabled", !draft.pulseEnabled)}>
                      <label className="field-group">
                        <span>Target</span>
                        <select
                          value={draft.pulseTarget}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.pulseTarget = event.target.value;
                            })
                          }
                        >
                          {[draft.pulseTarget, "$alpha", "$envmapcontrast"]
                            .filter((value, index, array) => array.indexOf(value) === index)
                            .map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                        </select>
                      </label>

                      <RangeRow
                        label="Minimum"
                        min={0}
                        max={3}
                        step={0.01}
                        value={draft.pulseMin}
                        onChange={(value) => updateNumber("pulseMin", value)}
                        compact
                      />
                      <RangeRow
                        label="Maximum"
                        min={0}
                        max={3}
                        step={0.01}
                        value={draft.pulseMax}
                        onChange={(value) => updateNumber("pulseMax", value)}
                        compact
                      />
                      <RangeRow
                        label="Period"
                        min={0.1}
                        max={8}
                        step={0.05}
                        value={draft.pulsePeriod}
                        onChange={(value) => updateNumber("pulsePeriod", value)}
                        compact
                      />
                    </ProxyBox>
                  </div>
                </article>
              </div>
            )}

            {view === "code" && (
              <div className="editor-grid single">
                <article className="panel panel-wide">
                  <div className="panel-head">
                    <div>
                      <p className="section-label">Code</p>
                      <h3>Edit VMT directly</h3>
                    </div>

                    <div className="code-meta">
                      <span className="meta-chip">{preservedEntries} extra entries</span>
                      <span className="meta-chip">{preservedProxies} extra proxies</span>
                      {hasUnknownKeys ? <span className="meta-chip warning">Unknown keys found</span> : null}
                    </div>
                  </div>

                  {hasUnknownKeys ? (
                    <div className="code-warning-strip" title="Unknown keys are preserved, shown here, and remain editable in the code box below.">
                      <span className="code-warning-label">Unknown</span>
                      <div className="unknown-chip-list">
                        {unknownEntryKeys.map((key) => (
                          <span key={`entry-${key}`} className="unknown-chip">
                            {key}
                          </span>
                        ))}
                        {unknownProxyKeys.map((key) => (
                          <span key={`proxy-${key}`} className="unknown-chip">
                            Proxies:{key}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {codeError ? (
                    <div className="code-error" title={codeError}>
                      {codeError}
                    </div>
                  ) : null}

                  <textarea
                    className="code-editor"
                    value={codeDraft}
                    spellCheck={false}
                    onChange={(event) => handleCodeChange(event.target.value)}
                    title="Edit the VMT directly. Valid changes update the rest of the app immediately."
                  />
                </article>
              </div>
            )}

            </div>

            <aside className="inspector-pane">
              <section className="panel inspector-card">
                <div className="panel-head inspector-head">
                  <div>
                    <p className="section-label">Preview</p>
                    <h3>Texture</h3>
                  </div>
                  <span className="meta-chip">{frameLabel}</span>
                </div>

                <div
                  className={[
                    "material-stage",
                    "inspector-stage",
                    draft.additive ? "additive" : "",
                    draft.selfillum ? "self-illum" : "",
                    draft.wireframe ? "wireframe" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {basePreview ? (
                    <>
                      <img
                        className="stage-base"
                        src={basePreview.dataUrl}
                        alt="Base texture preview"
                        style={{
                          opacity: draft.translucent || draft.alphatest ? clamp(liveAlpha, 0.18, 1) : 1,
                          transform: baseTransform,
                        }}
                      />
                      {detailPreview ? (
                        <img
                          className="stage-detail"
                          src={detailPreview.dataUrl}
                          alt="Detail texture preview"
                          style={{
                            opacity: clamp(0.14 + draft.detailScale * 0.08, 0.14, 0.58),
                            transform: detailTransform,
                          }}
                        />
                      ) : null}
                      {tintActive ? <div className="stage-tint" style={{ backgroundColor: normalizeHexColor(draft.colorTint) }} /> : null}
                      <div
                        className="stage-shine"
                        style={{ opacity: draft.envmapTexture ? clamp(0.08 + liveEnvmapContrast * 0.16, 0.08, 0.52) : 0 }}
                      />
                    </>
                  ) : (
                    <div className="stage-empty">
                      <strong>No preview</strong>
                      <span>Open a VTF or pick a base texture.</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="panel inspector-card">
                <div className="panel-head inspector-head">
                  <div>
                    <p className="section-label">Inspector</p>
                    <h3>Details</h3>
                  </div>
                </div>

                <div className="preview-info no-margin">
                  <InfoRow
                    label="Opened file"
                    value={basePreview ? basePreview.fileName : isTextureDraft ? getFileName(sourceTexturePath) : "Not set"}
                  />
                  <InfoRow
                    label="Type"
                    value={basePreview ? (basePreview.sourceType === "vtf" ? "Valve Texture Format" : basePreview.sourceType.toUpperCase()) : "Not loaded"}
                  />
                  <InfoRow label="Resolution" value={basePreview ? `${basePreview.width} x ${basePreview.height}` : "Not available"} />
                  <InfoRow label="Base" value={describePreviewState(basePreviewState, basePreview, draft.baseTexture)} />
                  <InfoRow label="Detail" value={describePreviewState(detailPreviewState, detailPreview, draft.detailTexture)} />
                  <InfoRow label="Tint" value={normalizeHexColor(draft.colorTint)} />
                  {basePreview?.vtfFormat ? <InfoRow label="Format" value={basePreview.vtfFormat} /> : null}
                  {basePreview?.vtfVersion ? <InfoRow label="Version" value={basePreview.vtfVersion} /> : null}
                  {basePreview?.mipmaps != null ? <InfoRow label="Mipmaps" value={String(basePreview.mipmaps)} /> : null}
                  {basePreview?.frames != null ? <InfoRow label="Frames" value={String(basePreview.frames)} /> : null}
                  {frameCount > 1 ? <InfoRow label="Preview FPS" value={formatPreviewNumber(effectivePreviewFps)} /> : null}
                </div>
              </section>

            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

function RangeRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  compact?: boolean;
}) {
  return (
    <label className={compact ? "range-row compact" : "range-row"}>
      <div>
        <span>{label}</span>
        <input
          className="range-number"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          title={`${label}: edit the numeric value directly`}
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            if (Number.isFinite(nextValue)) {
              onChange(nextValue);
            }
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        title={`${label}: drag to change`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ProxyBox({
  title,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <article className={enabled ? "proxy-box active" : "proxy-box"}>
      <div className="proxy-head">
        <h4>{title}</h4>
        <button
          type="button"
          className={enabled ? "small-toggle active" : "small-toggle"}
          onClick={onToggle}
          title={`${enabled ? "Disable" : "Enable"} ${title}`}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      <div className="proxy-body">{children}</div>
    </article>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row" title={`${label}: ${value}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function isNonDraggableTarget(target: HTMLElement) {
  return Boolean(target.closest("button, input, select, textarea, a, [data-no-drag='true']"));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeHexColor(value: string) {
  const trimmed = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed
      .split("")
      .map((part) => part + part)
      .join("")
      .toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  return "#ffffff";
}

function samplePulse(timeSeconds: number, min: number, max: number, period: number) {
  const safePeriod = Math.max(period, 0.05);
  const phase = (timeSeconds / safePeriod) * Math.PI * 2;
  const center = (min + max) / 2;
  const amplitude = (max - min) / 2;
  return center + Math.sin(phase) * amplitude;
}

function buildScrollTransform(enabled: boolean, rate: number, angle: number, timeSeconds: number) {
  if (!enabled) {
    return "translate3d(0, 0, 0) scale(1.02)";
  }

  const radians = (angle * Math.PI) / 180;
  const distance = rate * timeSeconds * 28;
  const x = Math.cos(radians) * distance;
  const y = Math.sin(radians) * distance * -1;
  return `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(1.08)`;
}

function formatPreviewNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isTextureSource(path: string) {
  return /\.(vtf|png|tga|jpg|jpeg)$/i.test(path);
}

function getFileName(path: string | null) {
  return path?.split(/[/\\]/).pop() ?? "material.vmt";
}

function getStem(path: string | null) {
  return getFileName(path).replace(/\.[^.]+$/, "");
}

function getDefaultSaveName(currentFile: string | null, sourceTexturePath: string | null) {
  if (currentFile) return getFileName(currentFile);
  if (sourceTexturePath) return `${getStem(sourceTexturePath)}.vmt`;
  return "material.vmt";
}

function getDocumentName(currentFile: string | null, sourceTexturePath: string | null) {
  if (currentFile) return getFileName(currentFile);
  if (sourceTexturePath) return getFileName(sourceTexturePath);
  return "New Material";
}

function describePreviewState(state: PreviewState, preview: TexturePreview | null, reference: string) {
  if (preview) {
    return `${preview.fileName} • ${preview.width} x ${preview.height}`;
  }
  if (!reference) {
    return "Not set";
  }
  if (state === "loading") {
    return "Loading preview...";
  }
  return "Not found or unsupported";
}

function collectUnknownEntryKeys(nodes: Array<EntryNode | { type: "block"; key: string; children: unknown[] }>) {
  return Array.from(
    new Set(
      nodes
        .filter((node): node is EntryNode => node.type === "entry")
        .map((node) => node.key)
        .filter((key) => key.trim().startsWith("$")),
    ),
  );
}

export default App;
