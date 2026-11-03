#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

mod scan;
use scan::Found;

/// games.json is read-modify-written from several places (the UI thread and the thread
/// that waits for a game to close), so every writer takes this lock first.
static LOCK: Mutex<()> = Mutex::new(());
fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Clone)]
struct Game {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    last_played: u64,
    /// total seconds this game has been running (only counted when the launcher can watch it)
    #[serde(default)]
    total_secs: u64,
    /// local day numbers (days since 1970-01-01, computed by the page) on which it was launched
    #[serde(default)]
    play_days: Vec<u32>,
    /// "exe" = start the .exe directly, "steam" / "epic" = start through the store
    #[serde(default = "kind_exe")]
    kind: String,
    /// Steam app id or Epic app name (empty for plain .exe games)
    #[serde(default)]
    launch: String,
    /// install folder, used to check the game is still there and to time Steam/Epic games
    #[serde(default)]
    folder: String,
}

fn kind_exe() -> String {
    "exe".into()
}

#[derive(Serialize)]
struct GameView {
    id: String,
    name: String,
    path: String,
    cover: String,
    last_played: u64,
    total_secs: u64,
    play_days: Vec<u32>,
    kind: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(d.join("icons")).map_err(|e| e.to_string())?;
    fs::create_dir_all(d.join("covers")).map_err(|e| e.to_string())?;
    Ok(d)
}

fn load(app: &AppHandle) -> Vec<Game> {
    data_dir(app)
        .ok()
        .and_then(|d| fs::read_to_string(d.join("games.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, games: &[Game]) -> Result<(), String> {
    let d = data_dir(app)?;
    let s = serde_json::to_string_pretty(games).map_err(|e| e.to_string())?;
    fs::write(d.join("games.json"), s).map_err(|e| e.to_string())
}

fn views(app: &AppHandle) -> Result<Vec<GameView>, String> {
    let d = data_dir(app)?;
    let mut games = load(app);
    games.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    Ok(games
        .into_iter()
        .map(|g| {
            let cover = fs::read(d.join("covers").join(format!("{}.webp", g.id)))
                .map(|b| format!("data:image/webp;base64,{}", STANDARD.encode(b)))
                .unwrap_or_default();
            GameView {
                id: g.id,
                name: g.name,
                path: g.path,
                cover,
                last_played: g.last_played,
                total_secs: g.total_secs,
                play_days: g.play_days,
                kind: g.kind,
            }
        })
        .collect())
}

fn make_id(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.to_lowercase().hash(&mut h);
    format!("{:016x}", h.finish())
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Pulls the game's icon (PNG, up to 256px) and product name straight out of the .exe.
fn extract(app: &AppHandle, exe: &str, id: &str) -> Result<String, String> {
    let d = data_dir(app)?;
    let script = d.join("extract.ps1");
    fs::write(&script, include_str!("extract.ps1")).map_err(|e| e.to_string())?;
    let icon = d.join("icons").join(format!("{id}.png"));

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-exe")
        .arg(exe)
        .arg("-out")
        .arg(&icon);
    let out = hidden(&mut cmd).output().map_err(|e| e.to_string())?;

    let name = String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_matches('\u{feff}')
        .to_string();
    if name.is_empty() {
        Ok(Path::new(exe)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Game".into()))
    } else {
        Ok(name)
    }
}

#[tauri::command]
fn list_games(app: AppHandle) -> Result<Vec<GameView>, String> {
    views(&app)
}

#[tauri::command]
async fn add_games(app: AppHandle) -> Result<Vec<GameView>, String> {
    let picked = app.dialog().file().add_filter("Games", &["exe"]).blocking_pick_files();

    if let Some(files) = picked {
        let _guard = lock();
        let mut games = load(&app);
        for f in files {
            let Ok(p) = f.into_path() else { continue };
            let path = p.to_string_lossy().to_string();
            let id = make_id(&path);
            if games.iter().any(|g| g.id == id) {
                continue;
            }
            let name = extract(&app, &path, &id)?;
            games.push(Game {
                id,
                name,
                path,
                last_played: now(),
                total_secs: 0,
                play_days: Vec::new(),
                kind: kind_exe(),
                launch: String::new(),
                folder: String::new(),
            });
        }
        save(&app, &games)?;
    }
    views(&app)
}

/// Marks the scan results that are already in the launcher.
fn mark_existing(app: &AppHandle, mut list: Vec<Found>) -> Vec<Found> {
    let have: Vec<String> = load(app).into_iter().map(|g| g.id).collect();
    for f in list.iter_mut() {
        f.already = have.contains(&make_id(&scan::key(f)));
    }
    list
}

/// Looks for Steam, Epic and GOG games. Only reports; nothing is saved.
#[tauri::command]
async fn scan_stores(app: AppHandle) -> Result<Vec<Found>, String> {
    let mut all = Vec::new();
    all.extend(scan::steam_games());
    all.extend(scan::epic_games());
    all.extend(scan::gog_games());
    Ok(mark_existing(&app, all))
}

/// Asks for a folder, then treats each sub-folder in it as a game. `None` = the picker was cancelled.
#[tauri::command]
async fn scan_folder(app: AppHandle) -> Result<Option<Vec<Found>>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Ok(root) = picked.into_path() else { return Ok(None) };
    Ok(Some(mark_existing(&app, scan::folder_games(&root))))
}

/// Adds the games ticked in the scan list.
#[tauri::command]
fn add_found(app: AppHandle, items: Vec<Found>) -> Result<Vec<GameView>, String> {
    let _guard = lock();
    let mut games = load(&app);
    for f in items {
        let id = make_id(&scan::key(&f));
        let name = f.name.trim().to_string();
        if name.is_empty() || games.iter().any(|g| g.id == id) {
            continue;
        }
        games.push(Game {
            id,
            name,
            path: f.path,
            last_played: 0, // never played yet
            total_secs: 0,
            play_days: Vec::new(),
            kind: if f.kind == "steam" || f.kind == "epic" {
                f.kind
            } else {
                kind_exe()
            },
            launch: f.launch,
            folder: f.folder,
        });
    }
    save(&app, &games)?;
    views(&app)
}

#[tauri::command]
fn remove_game(app: AppHandle, id: String) -> Result<Vec<GameView>, String> {
    let _guard = lock();
    let mut games = load(&app);
    games.retain(|g| g.id != id);
    save(&app, &games)?;
    let d = data_dir(&app)?;
    let _ = fs::remove_file(d.join("icons").join(format!("{id}.png")));
    let _ = fs::remove_file(d.join("covers").join(format!("{id}.webp")));
    views(&app)
}

fn cover_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Bad game id".into());
    }
    Ok(data_dir(app)?.join("covers").join(format!("{id}.webp")))
}

/// The page crops/shrinks the picked image to a square WebP and sends it here as a data URL.
#[tauri::command]
fn save_cover(app: AppHandle, id: String, data: String) -> Result<Vec<GameView>, String> {
    let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(data.as_str());
    let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    fs::write(cover_path(&app, &id)?, bytes).map_err(|e| e.to_string())?;
    views(&app)
}

#[tauri::command]
fn remove_cover(app: AppHandle, id: String) -> Result<Vec<GameView>, String> {
    let _ = fs::remove_file(cover_path(&app, &id)?);
    views(&app)
}

#[tauri::command]
fn rename_game(app: AppHandle, id: String, name: String) -> Result<Vec<GameView>, String> {
    let _guard = lock();
    let mut games = load(&app);
    if let Some(g) = games.iter_mut().find(|g| g.id == id) {
        g.name = name.trim().to_string();
    }
    save(&app, &games)?;
    views(&app)
}

/// Adds a finished session to the game's total play time.
fn add_playtime(app: &AppHandle, id: &str, secs: u64) {
    let _guard = lock();
    let mut games = load(app);
    if let Some(g) = games.iter_mut().find(|g| g.id == id) {
        g.total_secs = g.total_secs.saturating_add(secs);
        let _ = save(app, &games);
    }
}

fn norm_path(p: &str) -> String {
    format!("{}\\", p.replace('/', "\\").to_lowercase().trim_end_matches('\\'))
}

/// A game started through Steam or Epic isn't our child process, so we can't wait() on it.
/// Instead we look for any running program that lives inside the game's install folder,
/// time it from the moment it shows up, and tell the page when it is gone.
fn watch_install(app: AppHandle, id: String, folder: String) {
    std::thread::spawn(move || {
        let root = norm_path(&folder);
        let mut sys = System::new();
        let begin = Instant::now();
        let mut started: Option<Instant> = None;
        let mut gone = 0;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
            );
            let running = sys.processes().values().any(|p| {
                p.exe()
                    .map(|e| norm_path(&e.to_string_lossy()).starts_with(&root))
                    .unwrap_or(false)
            });
            match (started.is_some(), running) {
                (false, true) => started = Some(Instant::now()),
                (false, false) => {
                    if begin.elapsed() > Duration::from_secs(180) {
                        break; // never saw it start (cancelled, or still updating)
                    }
                }
                (true, true) => gone = 0,
                (true, false) => {
                    gone += 1;
                    if gone >= 3 {
                        break;
                    }
                }
            }
        }
        if let Some(s) = started {
            // the last three polls (6 s) were spent waiting to be sure it had closed
            add_playtime(&app, &id, s.elapsed().as_secs().saturating_sub(6));
        }
        let _ = app.emit("game-exited", id);
    });
}

#[tauri::command]
fn launch_game(app: AppHandle, id: String, day: Option<u32>) -> Result<bool, String> {
    let _guard = lock();
    let mut games = load(&app);
    let g = games.iter_mut().find(|g| g.id == id).ok_or("Game not found")?;

    let tracked = if g.kind == "steam" || g.kind == "epic" {
        // started through the store, like double-clicking it in Steam / Epic
        if g.folder.is_empty() || !Path::new(&g.folder).exists() {
            return Err(format!(
                "{} isn't installed anymore. Remove it from the launcher.",
                g.name
            ));
        }
        let uri = if g.kind == "steam" {
            format!("steam://rungameid/{}", g.launch)
        } else {
            format!("com.epicgames.launcher://apps/{}?action=launch&silent=true", g.launch)
        };
        let mut open = Command::new("rundll32");
        open.arg("url.dll,FileProtocolHandler").arg(&uri);
        hidden(&mut open).spawn().map_err(|e| e.to_string())?;
        watch_install(app.clone(), g.id.clone(), g.folder.clone());
        true
    } else {
        if !Path::new(&g.path).exists() {
            return Err(format!("{} was moved or deleted. Remove it and add it again.", g.name));
        }
        let dir = Path::new(&g.path).parent().map(|p| p.to_path_buf()).unwrap_or_default();

        let mut direct = Command::new(&g.path);
        direct.current_dir(&dir);
        // true = we can watch the game and tell the UI when it closes
        match direct.spawn() {
            Ok(mut child) => {
                let handle = app.clone();
                let gid = g.id.clone();
                let started = Instant::now();
                std::thread::spawn(move || {
                    let _ = child.wait();
                    add_playtime(&handle, &gid, started.elapsed().as_secs());
                    let _ = handle.emit("game-exited", gid);
                });
                true
            }
            Err(_) => {
                // Games that need admin rights: let Windows show the UAC prompt (can't be watched).
                let mut via_shell = Command::new("cmd");
                via_shell.args(["/C", "start", "", "/D"]).arg(&dir).arg(&g.path);
                hidden(&mut via_shell).spawn().map_err(|e| e.to_string())?;
                false
            }
        }
    };

    g.last_played = now();
    if let Some(d) = day {
        if !g.play_days.contains(&d) {
            g.play_days.push(d);
            g.play_days.sort_unstable();
            if g.play_days.len() > 730 {
                g.play_days.remove(0);
            }
        }
    }
    save(&app, &games)?;
    Ok(tracked)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_games,
            add_games,
            scan_stores,
            scan_folder,
            add_found,
            remove_game,
            rename_game,
            save_cover,
            remove_cover,
            launch_game
        ])
        .run(tauri::generate_context!())
        .expect("error while running Game Launcher");
}
