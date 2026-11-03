[README.md](https://github.com/user-attachments/files/34334164/README.md)
# DiskLauncher

A game launcher for Windows where every game is a floating CD.
Add any `.exe` game with the **+** button, give its disc your own picture, and press start.
The look is inspired by the Switch 2 home menu. This is a fan project and is not affiliated with Nintendo.

## Screenshots

<img width="960" height="540" alt="Screenshot 2026-11-03 165941" src="https://github.com/user-attachments/assets/04fcd3bb-4ac0-41c5-b7e5-484068b6b7d5" />

<img width="960" height="540" alt="image" src="https://github.com/user-attachments/assets/e719559d-8989-4f3c-8d97-1644ab3b2068" />


## Features

- **Add games in one click.** Pick a game's `.exe` with the **+** button and it appears on the home row. The name is read from the file, and you can rename it any time.
- **Discs, not icons.** Every game is a plain silver CD that floats up and down. Attach your own image to any disc from the options menu.
- **Now playing screen.** While a game runs, its disc spins on screen with a soft tune. The launcher returns when the game closes.
- **Sounds and animations** for moving, opening menus and starting games. Sound can be turned off.
- **Light and dark theme**, plus fullscreen.
- **Keyboard, mouse and gamepad** support.

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move | Arrow keys or mouse wheel | D-pad or left stick |
| Start game | `Enter` or click a disc | A |
| Back | `Esc` | B |
| Options (rename, disc image, remove) | `X`, `Delete` or right-click | X |
| Add game | `N` or the **+** disc | Y |
| Theme / sound / fullscreen | `T` / `M` / `F11` | |

## Download

Get `DiskLauncher.exe` from the [Releases](../../releases) page and run it.

- Needs Windows 10 or 11 with the Microsoft WebView2 Runtime (already included on up-to-date systems).
- Windows may show a "protected your PC" warning because the app isn't signed. Click **More info**, then **Run anyway**.
- Your game list and disc images are stored on your own PC.

## Build from source

You need [Rust](https://rustup.rs) and [Node.js](https://nodejs.org).

```
npm install
npm run dev      # run in development
npm run build    # build the exe into src-tauri/target/release
```

## Built with

[Tauri 2](https://tauri.app), Rust, and plain HTML, CSS and JavaScript.
Font: [Rubik](https://fonts.google.com/specimen/Rubik) (SIL Open Font License).
