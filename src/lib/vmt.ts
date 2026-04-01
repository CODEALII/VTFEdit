export type EntryNode = { type: "entry"; key: string; value: string };
export type BlockNode = { type: "block"; key: string; children: VmtNode[] };
export type VmtNode = EntryNode | BlockNode;

export type MaterialDraft = {
  shader: string;
  baseTexture: string;
  detailTexture: string;
  envmapTexture: string;
  surfaceprop: string;
  colorTint: string;
  alpha: number;
  detailBlendMode: number;
  detailScale: number;
  envmapContrast: number;
  envmapSaturation: number;
  model: boolean;
  translucent: boolean;
  alphatest: boolean;
  additive: boolean;
  selfillum: boolean;
  wireframe: boolean;
  vertexcolor: boolean;
  nolod: boolean;
  nofog: boolean;
  nocull: boolean;
  ignorez: boolean;
  noFullbright: boolean;
  phong: boolean;
  animatedEnabled: boolean;
  animatedFps: number;
  baseScrollEnabled: boolean;
  baseScrollRate: number;
  baseScrollAngle: number;
  detailScrollEnabled: boolean;
  detailScrollRate: number;
  detailScrollAngle: number;
  pulseEnabled: boolean;
  pulseTarget: string;
  pulseMin: number;
  pulseMax: number;
  pulsePeriod: number;
  presentKeys: Set<string>;
  extraNodes: VmtNode[];
  extraProxyNodes: VmtNode[];
};

export const defaultDraft = (): MaterialDraft => ({
  shader: "VertexLitGeneric",
  baseTexture: "",
  detailTexture: "",
  envmapTexture: "",
  surfaceprop: "",
  colorTint: "#ffffff",
  alpha: 1,
  detailBlendMode: 0,
  detailScale: 1,
  envmapContrast: 1,
  envmapSaturation: 1,
  model: false,
  translucent: false,
  alphatest: false,
  additive: false,
  selfillum: false,
  wireframe: false,
  vertexcolor: false,
  nolod: false,
  nofog: false,
  nocull: false,
  ignorez: false,
  noFullbright: false,
  phong: false,
  animatedEnabled: false,
  animatedFps: 15,
  baseScrollEnabled: false,
  baseScrollRate: 0.08,
  baseScrollAngle: 90,
  detailScrollEnabled: false,
  detailScrollRate: 0.1,
  detailScrollAngle: 90,
  pulseEnabled: false,
  pulseTarget: "$alpha",
  pulseMin: 0,
  pulseMax: 1,
  pulsePeriod: 1,
  presentKeys: new Set<string>(),
  extraNodes: [],
  extraProxyNodes: [],
});

const boolMap: Record<string, keyof MaterialDraft> = {
  $model: "model",
  $translucent: "translucent",
  $alphatest: "alphatest",
  $additive: "additive",
  $selfillum: "selfillum",
  $wireframe: "wireframe",
  $vertexcolor: "vertexcolor",
  $nolod: "nolod",
  $nofog: "nofog",
  $nocull: "nocull",
  $ignorez: "ignorez",
  $no_fullbright: "noFullbright",
  $phong: "phong",
};

export function parseVmt(text: string): MaterialDraft {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return defaultDraft();
  }

  let index = 0;
  const shader = tokens[index++] ?? "VertexLitGeneric";
  if (tokens[index++] !== "{") {
    throw new Error("Invalid VMT file.");
  }

  const draft = defaultDraft();
  draft.shader = shader;
  const nodes = parseBlock(tokens, () => index, (value) => {
    index = value;
  });

  for (const node of nodes) {
    if (node.type === "block") {
      if (node.key.toLowerCase() === "proxies") {
        applyProxyBlock(draft, node.children);
      } else {
        draft.extraNodes.push(node);
      }
      continue;
    }

    const key = node.key.toLowerCase();
    draft.presentKeys.add(key);
    if (key === "$basetexture") draft.baseTexture = node.value;
    else if (key === "$detail") draft.detailTexture = node.value;
    else if (key === "$envmap") draft.envmapTexture = node.value;
    else if (key === "$surfaceprop") draft.surfaceprop = node.value;
    else if (key === "$color") draft.colorTint = parseColorValue(node.value);
    else if (key === "$alpha") draft.alpha = numberValue(node.value, 1);
    else if (key === "$detailblendmode") draft.detailBlendMode = integerValue(node.value, 0);
    else if (key === "$detailscale") draft.detailScale = numberValue(node.value, 1);
    else if (key === "$envmapcontrast") draft.envmapContrast = numberValue(node.value, 1);
    else if (key === "$envmapsaturation") draft.envmapSaturation = numberValue(node.value, 1);
    else if (key in boolMap) (draft as Record<string, unknown>)[boolMap[key]] = boolValue(node.value);
    else draft.extraNodes.push(node);
  }

  return draft;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && !/[\r\n]/.test(text[index])) index += 1;
      continue;
    }
    if (char === "{") {
      tokens.push("{");
      index += 1;
      continue;
    }
    if (char === "}") {
      tokens.push("}");
      index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let buffer = "";
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && text[index + 1]) {
          buffer += text[index + 1];
          index += 2;
          continue;
        }
        buffer += text[index];
        index += 1;
      }
      index += 1;
      tokens.push(buffer);
      continue;
    }
    const start = index;
    while (index < text.length && !/\s/.test(text[index]) && !["{", "}", '"'].includes(text[index])) {
      index += 1;
    }
    tokens.push(text.slice(start, index));
  }
  return tokens;
}

function parseBlock(tokens: string[], getIndex: () => number, setIndex: (value: number) => void): VmtNode[] {
  const nodes: VmtNode[] = [];
  let index = getIndex();
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === "}") {
      setIndex(index);
      return nodes;
    }
    const key = token;
    const next = tokens[index++];
    if (next === "{") {
      setIndex(index);
      const children = parseBlock(tokens, getIndex, setIndex);
      index = getIndex();
      nodes.push({ type: "block", key, children });
    } else {
      nodes.push({ type: "entry", key, value: next ?? "" });
    }
  }
  setIndex(index);
  return nodes;
}

function applyProxyBlock(draft: MaterialDraft, nodes: VmtNode[]) {
  for (const node of nodes) {
    if (node.type !== "block") {
      draft.extraProxyNodes.push(node);
      continue;
    }

    const name = node.key.toLowerCase();
    if (name === "animatedtexture" && !draft.animatedEnabled) {
      draft.animatedEnabled = true;
      draft.animatedFps = numberValue(findValue(node.children, "animatedTextureFrameRate", "15"), 15);
      continue;
    }
    if (name === "texturescroll") {
      const target = findValue(node.children, "textureScrollVar", "$basetexturetransform").toLowerCase();
      if (target === "$detailtexturetransform") {
        if (draft.detailScrollEnabled) {
          draft.extraProxyNodes.push(node);
          continue;
        }
        draft.detailScrollEnabled = true;
        draft.detailScrollRate = numberValue(findValue(node.children, "textureScrollRate", "0.1"), 0.1);
        draft.detailScrollAngle = numberValue(findValue(node.children, "textureScrollAngle", "90"), 90);
      } else {
        if (draft.baseScrollEnabled) {
          draft.extraProxyNodes.push(node);
          continue;
        }
        draft.baseScrollEnabled = true;
        draft.baseScrollRate = numberValue(findValue(node.children, "textureScrollRate", "0.08"), 0.08);
        draft.baseScrollAngle = numberValue(findValue(node.children, "textureScrollAngle", "90"), 90);
      }
      continue;
    }
    if (name === "sine" && !draft.pulseEnabled) {
      draft.pulseEnabled = true;
      draft.pulseTarget = findValue(node.children, "resultVar", findValue(node.children, "resultvar", "$alpha"));
      draft.pulseMin = numberValue(findValue(node.children, "sinemin", findValue(node.children, "min", "0")), 0);
      draft.pulseMax = numberValue(findValue(node.children, "sinemax", findValue(node.children, "max", "1")), 1);
      draft.pulsePeriod = numberValue(findValue(node.children, "sineperiod", "1"), 1);
      continue;
    }
    draft.extraProxyNodes.push(node);
  }
}

function findValue(nodes: VmtNode[], key: string, fallback: string) {
  const wanted = key.toLowerCase();
  const entry = nodes.find((node) => node.type === "entry" && node.key.toLowerCase() === wanted) as EntryNode | undefined;
  return entry?.value ?? fallback;
}

function boolValue(raw: string) {
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function numberValue(raw: string, fallback: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerValue(raw: string, fallback: number) {
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, "");
}

function parseColorValue(raw: string) {
  const values = Array.from(raw.matchAll(/-?\d*\.?\d+/g), (match) => Number(match[0])).filter((value) => Number.isFinite(value));
  if (values.length < 3) {
    return "#ffffff";
  }

  const useUnitScale = Math.max(values[0], values[1], values[2]) <= 1;
  const channels = values.slice(0, 3).map((value) =>
    clampChannel(Math.round((useUnitScale ? value * 255 : value))),
  );

  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function formatColorValue(color: string) {
  const [r, g, b] = hexToRgb(color);
  return `[${r} ${g} ${b}]`;
}

function hexToRgb(color: string) {
  const normalized = color.replace("#", "");
  const value = normalized.length === 3 ? normalized.split("").map((part) => part + part).join("") : normalized.padEnd(6, "f").slice(0, 6);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ].map((channel) => clampChannel(channel));
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, value));
}

function renderNode(node: VmtNode, indent: number): string[] {
  const prefix = "\t".repeat(indent);
  if (node.type === "entry") {
    return [`${prefix}"${node.key}" "${node.value}"`];
  }
  return [
    `${prefix}"${node.key}"`,
    `${prefix}{`,
    ...node.children.flatMap((child) => renderNode(child, indent + 1)),
    `${prefix}}`,
  ];
}

export function serializeVmt(draft: MaterialDraft): string {
  const lines = [`"${draft.shader}"`, "{"];
  const addValue = (key: string, value: string) => {
    if (value || draft.presentKeys.has(key)) {
      lines.push(`\t"${key}" "${value}"`);
    }
  };
  const addBool = (key: string, value: boolean) => {
    if (value || draft.presentKeys.has(key)) {
      lines.push(`\t"${key}" "${value ? 1 : 0}"`);
    }
  };
  const addNumber = (key: string, value: number, fallback: number) => {
    if (value !== fallback || draft.presentKeys.has(key)) {
      lines.push(`\t"${key}" "${formatNumber(value)}"`);
    }
  };

  addValue("$basetexture", draft.baseTexture);
  addValue("$detail", draft.detailTexture);
  addValue("$envmap", draft.envmapTexture);
  addValue("$surfaceprop", draft.surfaceprop);
  addValue("$color", formatColorValue(draft.colorTint));
  addBool("$model", draft.model);
  addBool("$translucent", draft.translucent);
  addBool("$alphatest", draft.alphatest);
  addBool("$additive", draft.additive);
  addNumber("$alpha", draft.alpha, 1);
  addBool("$selfillum", draft.selfillum);
  addBool("$wireframe", draft.wireframe);
  addBool("$vertexcolor", draft.vertexcolor);
  addBool("$nolod", draft.nolod);
  addBool("$nofog", draft.nofog);
  addBool("$nocull", draft.nocull);
  addBool("$ignorez", draft.ignorez);
  addBool("$no_fullbright", draft.noFullbright);
  addBool("$phong", draft.phong);
  addNumber("$detailblendmode", draft.detailBlendMode, 0);
  addNumber("$detailscale", draft.detailScale, 1);
  addNumber("$envmapcontrast", draft.envmapContrast, 1);
  addNumber("$envmapsaturation", draft.envmapSaturation, 1);

  draft.extraNodes.forEach((node) => lines.push(...renderNode(node, 1)));

  const proxyLines: string[] = [];
  if (draft.animatedEnabled) {
    proxyLines.push(
      '\t\t"AnimatedTexture"',
      "\t\t{",
      '\t\t\t"animatedTextureVar" "$basetexture"',
      '\t\t\t"animatedTextureFrameNumVar" "$frame"',
      `\t\t\t"animatedTextureFrameRate" "${formatNumber(draft.animatedFps)}"`,
      "\t\t}",
    );
  }
  if (draft.baseScrollEnabled) {
    proxyLines.push(
      '\t\t"TextureScroll"',
      "\t\t{",
      '\t\t\t"textureScrollVar" "$basetexturetransform"',
      `\t\t\t"textureScrollRate" "${formatNumber(draft.baseScrollRate)}"`,
      `\t\t\t"textureScrollAngle" "${formatNumber(draft.baseScrollAngle)}"`,
      "\t\t}",
    );
  }
  if (draft.detailScrollEnabled) {
    proxyLines.push(
      '\t\t"TextureScroll"',
      "\t\t{",
      '\t\t\t"textureScrollVar" "$detailtexturetransform"',
      `\t\t\t"textureScrollRate" "${formatNumber(draft.detailScrollRate)}"`,
      `\t\t\t"textureScrollAngle" "${formatNumber(draft.detailScrollAngle)}"`,
      "\t\t}",
    );
  }
  if (draft.pulseEnabled) {
    proxyLines.push(
      '\t\t"Sine"',
      "\t\t{",
      `\t\t\t"resultVar" "${draft.pulseTarget}"`,
      `\t\t\t"sinemin" "${formatNumber(draft.pulseMin)}"`,
      `\t\t\t"sinemax" "${formatNumber(draft.pulseMax)}"`,
      `\t\t\t"sineperiod" "${formatNumber(draft.pulsePeriod)}"`,
      "\t\t}",
    );
  }
  draft.extraProxyNodes.forEach((node) => proxyLines.push(...renderNode(node, 2)));

  if (proxyLines.length > 0) {
    lines.push("", '\t"Proxies"', "\t{", ...proxyLines, "\t}");
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function cloneDraft(draft: MaterialDraft): MaterialDraft {
  return {
    ...draft,
    presentKeys: new Set(draft.presentKeys),
    extraNodes: structuredClone(draft.extraNodes),
    extraProxyNodes: structuredClone(draft.extraProxyNodes),
  };
}

export function findMaterialsRoot(path: string | null) {
  if (!path) return null;
  const normalized = path.split("\\").join("/");
  const parts = normalized.split("/");
  const materialIndex = parts.findIndex((part: string) => part.toLowerCase() === "materials");
  if (materialIndex === -1) return null;
  return parts.slice(0, materialIndex + 1).join("/");
}

export function toMaterialReference(filePath: string, materialsRoot?: string | null) {
  const normalized = filePath.split("\\").join("/");
  const noExtension = normalized.replace(/\.(vtf|png|tga|jpg|jpeg)$/i, "");
  const root = materialsRoot?.split("\\").join("/") ?? findMaterialsRoot(noExtension);
  if (root && noExtension.toLowerCase().startsWith(root.toLowerCase())) {
    return noExtension.slice(root.length).replace(/^\/+/, "");
  }
  return noExtension.split("/").pop() ?? noExtension;
}

export function getDirectory(path: string | null) {
  if (!path) return null;
  const normalized = path.split("\\").join("/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? null : normalized.slice(0, index);
}
