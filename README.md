# VTFEdit+

`VTFEdit+` is a desktop material and texture editor for Source / Garry's Mod workflows.

It focuses on a simpler editor flow than classic `VTFEdit`:

- open `.vtf` and `.vmt` files directly
- preview Source materials live while editing
- edit common material flags with a GUI
- edit raw VMT code directly when needed
- keep unknown VMT keys instead of deleting them
- support animated VTF previews and material effects

## What It Uses

- `Tauri`
- `React`
- `TypeScript`
- `Rust`

## Current Features

- custom desktop window with dark UI
- direct `.vtf` preview support
- direct `.vmt` editing support
- live material preview
- editable code tab
- unknown key detection in VMT code
- restore button to return to the originally opened state
- portable Windows build support

## Development

Install dependencies:

```bash
yarn
```

Start the app:

```bash
yarn tauri dev
```

Build the frontend:

```bash
yarn build
```

Build a portable Windows executable:

```bash
yarn tauri build --no-bundle
```

The portable executable is created in:

```text
src-tauri/target/release/vtfedit-modern.exe
```

## Notes

- This project is still in early pre-release state.
- The UI and workflow are being tuned for a more native desktop feel.
- The main focus right now is fast VMT editing, VTF previewing, and easy material iteration for GMod.
