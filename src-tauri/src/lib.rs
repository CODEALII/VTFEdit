use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::{
    collections::HashSet,
    env, fs,
    io::Cursor,
    path::{Path, PathBuf},
};

const TEXTURE_EXTENSIONS: [&str; 5] = ["vtf", "png", "tga", "jpg", "jpeg"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TexturePreview {
    data_url: String,
    file_name: String,
    path: String,
    source_type: String,
    width: u32,
    height: u32,
    vtf_format: Option<String>,
    vtf_version: Option<String>,
    mipmaps: Option<u8>,
    frames: Option<u16>,
    frame_index: Option<u16>,
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    env::args()
        .nth(1)
        .filter(|value| is_supported_document(value))
}

#[tauri::command]
fn open_vmt_dialog(directory: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new()
        .add_filter("Valve Material", &["vmt"])
        .add_filter("Valve Texture", &["vtf", "png", "tga", "jpg", "jpeg"]);
    if let Some(path) = directory {
        dialog = dialog.set_directory(path);
    }
    dialog.pick_file().map(path_to_string)
}

#[tauri::command]
fn save_vmt_dialog(directory: Option<String>, file_name: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new().add_filter("Valve Material", &["vmt"]);
    if let Some(path) = directory {
        dialog = dialog.set_directory(path);
    }
    if let Some(name) = file_name {
        dialog = dialog.set_file_name(name);
    }
    dialog.save_file().map(path_to_string)
}

#[tauri::command]
fn open_texture_dialog(directory: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new()
        .add_filter("Texture Files", &["vtf", "png", "tga", "jpg", "jpeg"]);
    if let Some(path) = directory {
        dialog = dialog.set_directory(path);
    }
    dialog.pick_file().map(path_to_string)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_texture_preview(
    reference: String,
    materials_root: Option<String>,
    context_path: Option<String>,
    frame: Option<u32>,
) -> Result<Option<TexturePreview>, String> {
    let Some(resolved_path) = resolve_texture_path(
        &reference,
        materials_root.as_deref(),
        context_path.as_deref(),
    ) else {
        return Ok(None);
    };

    decode_texture_preview(&resolved_path, frame).map(Some)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn is_supported_document(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".vmt")
        || lower.ends_with(".vtf")
        || lower.ends_with(".png")
        || lower.ends_with(".tga")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
}

fn resolve_texture_path(
    reference: &str,
    materials_root: Option<&str>,
    context_path: Option<&str>,
) -> Option<PathBuf> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_extension = Path::new(trimmed).extension().is_some();
    let normalized = normalize_reference(trimmed);
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    let mut push_candidate = |path: PathBuf| {
        let key = path.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            candidates.push(path);
        }
    };

    if Path::new(trimmed).is_absolute() {
        push_candidate(PathBuf::from(trimmed));
        if !has_extension {
            for extension in TEXTURE_EXTENSIONS {
                push_candidate(PathBuf::from(format!("{trimmed}.{extension}")));
            }
        }
    }

    if let Some(root) = materials_root {
        push_reference_candidates(
            &mut push_candidate,
            Path::new(root),
            &normalized,
            has_extension,
        );
    }

    if let Some(context) = context_path {
        if let Some(parent) = Path::new(context).parent() {
            push_reference_candidates(&mut push_candidate, parent, &normalized, has_extension);
        }
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn normalize_reference(reference: &str) -> String {
    let normalized = reference.replace('\\', "/");
    normalized
        .strip_prefix("materials/")
        .unwrap_or(&normalized)
        .trim_matches('/')
        .to_string()
}

fn push_reference_candidates<F: FnMut(PathBuf)>(
    push_candidate: &mut F,
    base_path: &Path,
    normalized_reference: &str,
    has_extension: bool,
) {
    if normalized_reference.is_empty() {
        return;
    }

    if has_extension {
        push_candidate(base_path.join(normalized_reference));
        return;
    }

    for extension in TEXTURE_EXTENSIONS {
        push_candidate(base_path.join(format!("{normalized_reference}.{extension}")));
    }
}

fn decode_texture_preview(path: &Path, frame: Option<u32>) -> Result<TexturePreview, String> {
    let (dynamic_image, vtf_format, vtf_version, mipmaps, frames, frame_index) =
        match path.extension().and_then(|value| value.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("vtf") => {
                let bytes = fs::read(path).map_err(|error| error.to_string())?;
                let file = vtf::from_bytes(&bytes).map_err(|error| error.to_string())?;
                let available_frames = u32::from(file.header.frames.max(1));
                let selected_frame = frame.unwrap_or(0).min(available_frames.saturating_sub(1));
                let image = file
                    .highres_image
                    .decode(selected_frame)
                    .map_err(|error| error.to_string())?;

                (
                    DynamicImage::ImageRgba8(image.to_rgba8()),
                    Some(format!("{:?}", file.header.highres_image_format)),
                    Some(format!("{}.{}", file.header.version[0], file.header.version[1])),
                    Some(file.header.mipmap_count),
                    Some(file.header.frames),
                    Some(selected_frame as u16),
                )
            }
            _ => (
                image::open(path).map_err(|error| error.to_string())?,
                None,
                None,
                None,
                None,
                None,
            ),
        };

    let width = dynamic_image.width();
    let height = dynamic_image.height();

    let mut output = Cursor::new(Vec::new());
    dynamic_image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| error.to_string())?;

    Ok(TexturePreview {
        data_url: format!("data:image/png;base64,{}", BASE64.encode(output.into_inner())),
        file_name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "texture".to_string()),
        path: path_to_string(path.to_path_buf()),
        source_type: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file")
            .to_ascii_lowercase(),
        width,
        height,
        vtf_format,
        vtf_version,
        mipmaps,
        frames,
        frame_index,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_startup_file,
            open_vmt_dialog,
            save_vmt_dialog,
            open_texture_dialog,
            read_text_file,
            write_text_file,
            load_texture_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
