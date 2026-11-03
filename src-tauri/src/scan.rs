//! Finds games that are already installed on this PC.
//! Nothing in here saves anything: it only looks and reports what it found.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

/// One game the scanner found (also what the page sends back when you tick it).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Found {
    /// "exe" = start the .exe directly, "steam" / "epic" = start through the store
    pub kind: String,
    /// where it was found: "Steam", "Epic", "GOG" or "Folder"
    pub source: String,
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// Steam app id or Epic app name
    #[serde(default)]
    pub launch: String,
    /// install folder (used to check the game still exists and to time it)
    #[serde(default)]
    pub folder: String,
    /// already in the launcher (filled in by main.rs)
    #[serde(default)]
    pub already: bool,
}

/// What identifies a game, so the same game is never added twice.
pub fn key(f: &Found) -> String {
    match f.kind.as_str() {
        "steam" => format!("steam:{}", f.launch),
        "epic" => format!("epic:{}", f.launch),
        _ => f.path.clone(),
    }
}

fn sort_and_dedup(list: &mut Vec<Found>) {
    let mut seen = HashSet::new();
    list.retain(|f| seen.insert(key(f).to_lowercase()));
    list.sort_by_key(|f| f.name.to_lowercase());
}

// ---------------------------------------------------------------- Steam

/// Reads `"key"   "value"` lines from Valve .vdf / .acf text and returns every value for that key.
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        // "key"<tab>"value"  ->  ["", "key", "<tabs>", "value", ""]
        let parts: Vec<&str> = line.trim().split('"').collect();
        if parts.len() >= 4 && parts[1].eq_ignore_ascii_case(key) {
            out.push(parts[3].replace("\\\\", "\\"));
        }
    }
    out
}

fn vdf_first(text: &str, key: &str) -> Option<String> {
    vdf_values(text, key).into_iter().next().filter(|s| !s.is_empty())
}

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use winreg::{enums::*, RegKey};
    let cu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(k) = cu.open_subkey(r"Software\Valve\Steam") {
        if let Ok(p) = k.get_value::<String, _>("SteamPath") {
            return Some(PathBuf::from(p));
        }
    }
    let lm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for sub in [r"SOFTWARE\WOW6432Node\Valve\Steam", r"SOFTWARE\Valve\Steam"] {
        if let Ok(k) = lm.open_subkey(sub) {
            if let Ok(p) = k.get_value::<String, _>("InstallPath") {
                return Some(PathBuf::from(p));
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    None
}

fn is_steam_tool(appid: &str, name: &str) -> bool {
    appid == "228980"
        || name.starts_with("Steamworks Common Redistributables")
        || name.starts_with("Steam Linux Runtime")
        || name.starts_with("Proton ")
        || name.starts_with("Proton-")
        || name.starts_with("Steam Controller Configs")
}

/// Every installed Steam game (all library folders, including other drives).
pub fn steam_games() -> Vec<Found> {
    match steam_root() {
        Some(root) => steam_games_in(&root),
        None => Vec::new(),
    }
}

pub fn steam_games_in(root: &Path) -> Vec<Found> {
    let mut libs: Vec<PathBuf> = vec![root.to_path_buf()];
    if let Ok(t) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for line in t.lines() {
            let parts: Vec<&str> = line.trim().split('"').collect();
            if parts.len() < 4 {
                continue;
            }
            let value = parts[3].replace("\\\\", "\\");
            // new format: "path" "D:\SteamLibrary"   old format: "1" "D:\SteamLibrary"
            let is_key = parts[1].eq_ignore_ascii_case("path") || parts[1].chars().all(|c| c.is_ascii_digit());
            if is_key && (value.contains(":\\") || value.contains(":/")) {
                libs.push(PathBuf::from(value));
            }
        }
    }
    let mut seen_libs = HashSet::new();
    libs.retain(|p| seen_libs.insert(p.to_string_lossy().to_lowercase().replace('/', "\\")));

    let mut out = Vec::new();
    for lib in libs {
        let apps = lib.join("steamapps");
        let Ok(rd) = fs::read_dir(&apps) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if !(fname.starts_with("appmanifest_") && fname.ends_with(".acf")) {
                continue;
            }
            let Ok(t) = fs::read_to_string(e.path()) else { continue };
            let (Some(appid), Some(name), Some(dir)) = (
                vdf_first(&t, "appid"),
                vdf_first(&t, "name"),
                vdf_first(&t, "installdir"),
            ) else {
                continue;
            };
            let folder = apps.join("common").join(&dir);
            if !folder.is_dir() || is_steam_tool(&appid, &name) {
                continue;
            }
            out.push(Found {
                kind: "steam".into(),
                source: "Steam".into(),
                name,
                path: String::new(),
                launch: appid,
                folder: folder.to_string_lossy().to_string(),
                already: false,
            });
        }
    }
    sort_and_dedup(&mut out);
    out
}

// ---------------------------------------------------------------- Epic

pub fn epic_games() -> Vec<Found> {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    epic_games_in(
        &Path::new(&base)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests"),
    )
}

pub fn epic_games_in(manifests: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(manifests) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x.to_string_lossy().to_lowercase()) != Some("item".into()) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (name, app, dir, exe, main) = (
            s("DisplayName"),
            s("AppName"),
            s("InstallLocation"),
            s("LaunchExecutable"),
            s("MainGameAppName"),
        );
        // skip DLC / add-ons (they point at a main game), half-installed games, and entries with nothing to start
        if name.is_empty() || app.is_empty() || exe.is_empty() || dir.is_empty() {
            continue;
        }
        if !main.is_empty() && main != app {
            continue;
        }
        if v.get("bIsIncompleteInstall").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        if !Path::new(&dir).is_dir() {
            continue;
        }
        out.push(Found {
            kind: "epic".into(),
            source: "Epic".into(),
            name,
            path: Path::new(&dir).join(&exe).to_string_lossy().to_string(),
            launch: app,
            folder: dir,
            already: false,
        });
    }
    sort_and_dedup(&mut out);
    out
}

// ---------------------------------------------------------------- GOG

#[cfg(windows)]
pub fn gog_games() -> Vec<Found> {
    use winreg::{enums::*, RegKey};
    let lm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(root) = lm.open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sub in root.enum_keys().flatten() {
        let Ok(k) = root.open_subkey(&sub) else { continue };
        let name: String = k.get_value("gameName").unwrap_or_default();
        let exe: String = k.get_value("exe").unwrap_or_default();
        let dir: String = k.get_value("path").unwrap_or_default();
        let depends: String = k.get_value("dependsOn").unwrap_or_default(); // set on DLC
        if name.is_empty() || exe.is_empty() || !depends.is_empty() || !Path::new(&exe).exists() {
            continue;
        }
        out.push(Found {
            kind: "exe".into(),
            source: "GOG".into(),
            name,
            path: exe,
            launch: String::new(),
            folder: dir,
            already: false,
        });
    }
    sort_and_dedup(&mut out);
    out
}

#[cfg(not(windows))]
pub fn gog_games() -> Vec<Found> {
    Vec::new()
}

// ---------------------------------------------------------------- folder scan

const JUNK_FILES: &[&str] = &[
    "unins",
    "uninst",
    "setup",
    "install",
    "redist",
    "vcredist",
    "vc_redist",
    "dxsetup",
    "dxwebsetup",
    "directx",
    "dotnet",
    "ndp",
    "oalinst",
    "crashhandler",
    "crashreport",
    "crashpad",
    "crashsender",
    "bugreport",
    "unitycrashhandler",
    "updater",
    "patcher",
    "helper",
    "cefprocess",
    "cefsharp",
    "webview",
    "easyanticheat",
    "battleye",
    "beclient",
    "notification_helper",
    "createdump",
    "python",
    "java",
];
const JUNK_DIRS: &[&str] = &[
    "redist",
    "_commonredist",
    "directx",
    "vcredist",
    "dotnet",
    "crashreport",
    "crashpad",
    "__installer",
    "prereq",
    "easyanticheat",
    "battleye",
    "$recycle.bin",
    "system volume information",
];

fn is_exe(p: &Path) -> bool {
    p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false)
}
fn junk_exe(p: &Path) -> bool {
    let n = p
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    JUNK_FILES.iter().any(|j| n.contains(j))
}
fn junk_dir(p: &Path) -> bool {
    let n = p
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    JUNK_DIRS.iter().any(|j| n.contains(j))
}
fn alnum(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}
fn clean_name(s: &str) -> String {
    let s = s.replace('_', " ");
    let s = if s.contains(' ') { s } else { s.replace('.', " ") };
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The most likely "play" exe inside a game folder: the biggest real program in it,
/// unless one named like the folder is nearly as big (then that one).
pub fn best_exe(dir: &Path) -> Option<PathBuf> {
    let hint = alnum(&dir.file_name()?.to_string_lossy());
    let mut all: Vec<(u64, PathBuf, bool)> = Vec::new();
    let walker = WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| !(e.depth() > 0 && e.file_type().is_dir() && junk_dir(e.path())));
    for e in walker.flatten() {
        if !e.file_type().is_file() || !is_exe(e.path()) || junk_exe(e.path()) {
            continue;
        }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let stem = alnum(
            &e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
        let named = stem.len() >= 3 && (stem == hint || hint.contains(&stem) || stem.contains(&hint));
        all.push((size, e.path().to_path_buf(), named));
    }
    let max = all.iter().map(|a| a.0).max()?;
    all.iter()
        .filter(|a| a.2 && a.0 * 4 >= max)
        .max_by_key(|a| a.0)
        .or_else(|| all.iter().max_by_key(|a| a.0))
        .map(|a| a.1.clone())
}

/// Treats each sub-folder of `root` as one game, plus any .exe sitting directly in `root`.
pub fn folder_games(root: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(root) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if junk_dir(&p) {
                continue;
            }
            if let Some(exe) = best_exe(&p) {
                let name = clean_name(
                    &p.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                );
                out.push(Found {
                    kind: "exe".into(),
                    source: "Folder".into(),
                    name,
                    path: exe.to_string_lossy().to_string(),
                    launch: String::new(),
                    folder: p.to_string_lossy().to_string(),
                    already: false,
                });
            }
        } else if is_exe(&p) && !junk_exe(&p) {
            let name = clean_name(
                &p.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
            );
            out.push(Found {
                kind: "exe".into(),
                source: "Folder".into(),
                name,
                path: p.to_string_lossy().to_string(),
                launch: String::new(),
                folder: root.to_string_lossy().to_string(),
                already: false,
            });
        }
    }
    out.retain(|f| !f.name.is_empty());
    sort_and_dedup(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("scan_test_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn file(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn vdf_reading() {
        let t = "\"AppState\"\n{\n\t\"appid\"\t\t\"1245620\"\n\t\"name\"\t\t\"ELDEN RING\"\n\t\"installdir\"\t\t\"ELDEN RING\"\n}\n";
        assert_eq!(vdf_first(t, "appid").as_deref(), Some("1245620"));
        assert_eq!(vdf_first(t, "name").as_deref(), Some("ELDEN RING"));
        assert_eq!(vdf_first(t, "nope"), None);
    }

    #[test]
    fn steam_scan_finds_games_in_other_libraries_and_skips_tools() {
        let root = tmp("steam");
        let lib2 = tmp("steam_lib2");
        let apps = root.join("steamapps");
        fs::create_dir_all(apps.join("common").join("Celeste")).unwrap();
        fs::create_dir_all(apps.join("common").join("Steamworks Shared")).unwrap();
        fs::create_dir_all(lib2.join("steamapps").join("common").join("Hades")).unwrap();
        let esc = |p: &Path| p.to_string_lossy().replace('\\', "\\\\");
        fs::write(
            apps.join("libraryfolders.vdf"),
            format!(
                "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t}}\n}}\n",
                esc(&root),
                esc(&lib2)
            ),
        )
        .unwrap();
        fs::write(apps.join("appmanifest_504230.acf"), "\"AppState\"\n{\n\t\"appid\"\t\t\"504230\"\n\t\"name\"\t\t\"Celeste\"\n\t\"installdir\"\t\t\"Celeste\"\n}\n").unwrap();
        fs::write(apps.join("appmanifest_228980.acf"), "\"AppState\"\n{\n\t\"appid\"\t\t\"228980\"\n\t\"name\"\t\t\"Steamworks Common Redistributables\"\n\t\"installdir\"\t\t\"Steamworks Shared\"\n}\n").unwrap();
        fs::write(
            lib2.join("steamapps").join("appmanifest_1145360.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"1145360\"\n\t\"name\"\t\t\"Hades\"\n\t\"installdir\"\t\t\"Hades\"\n}\n",
        )
        .unwrap();

        let found = steam_games_in(&root);
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"Celeste"), "{names:?}");
        assert!(!names.contains(&"Steamworks Common Redistributables"), "{names:?}");
        assert_eq!(found.iter().find(|f| f.name == "Celeste").unwrap().launch, "504230");
        // second library is only picked up when the path looks like a Windows drive path
        if cfg!(windows) {
            assert!(names.contains(&"Hades"), "{names:?}");
        }
    }

    #[test]
    fn epic_scan_skips_dlc_and_incomplete() {
        let man = tmp("epic");
        let inst = tmp("epic_inst");
        let item = |app: &str, name: &str, main: &str, exe: &str, incomplete: bool| {
            format!(
                "{{\"DisplayName\":\"{name}\",\"AppName\":\"{app}\",\"MainGameAppName\":\"{main}\",\"LaunchExecutable\":\"{exe}\",\"InstallLocation\":\"{}\",\"bIsIncompleteInstall\":{incomplete}}}",
                inst.to_string_lossy().replace('\\', "\\\\")
            )
        };
        fs::write(
            man.join("a.item"),
            item("Fortnite", "Fortnite", "Fortnite", "Game.exe", false),
        )
        .unwrap();
        fs::write(man.join("b.item"), item("DlcPack", "Some DLC", "Fortnite", "", false)).unwrap();
        fs::write(
            man.join("c.item"),
            item("Half", "Half Installed", "Half", "H.exe", true),
        )
        .unwrap();
        fs::write(man.join("junk.txt"), "x").unwrap();
        let found = epic_games_in(&man);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].name, "Fortnite");
        assert_eq!(found[0].launch, "Fortnite");
        assert_eq!(found[0].kind, "epic");
    }

    #[test]
    fn folder_scan_picks_the_game_exe_and_skips_junk() {
        let root = tmp("folder");
        // Unity-style game: real exe + crash handler + uninstaller
        file(&root.join("Hollow_Knight").join("Hollow Knight.exe"), 900);
        file(&root.join("Hollow_Knight").join("UnityCrashHandler64.exe"), 5000);
        file(&root.join("Hollow_Knight").join("unins000.exe"), 4000);
        // Unreal-style: tiny launcher stub + big shipping exe in Binaries
        file(&root.join("Some Game").join("SomeGame.exe"), 300);
        file(
            &root
                .join("Some Game")
                .join("Binaries")
                .join("Win64")
                .join("SomeGame-Win64-Shipping.exe"),
            9000,
        );
        // redist folder only
        file(&root.join("Tools").join("_CommonRedist").join("vcredist.exe"), 100);
        // loose exe directly in the folder
        file(&root.join("Celeste.exe"), 700);
        file(&root.join("vc_redist.x64.exe"), 800);

        let found = folder_games(&root);
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Celeste", "Hollow Knight", "Some Game"], "{found:?}");
        let hk = found.iter().find(|f| f.name == "Hollow Knight").unwrap();
        assert!(hk.path.ends_with("Hollow Knight.exe"), "{}", hk.path);
        let sg = found.iter().find(|f| f.name == "Some Game").unwrap();
        assert!(sg.path.ends_with("SomeGame-Win64-Shipping.exe"), "{}", sg.path);
    }

    #[test]
    fn same_game_is_not_listed_twice() {
        let mut v = vec![
            Found {
                kind: "steam".into(),
                launch: "1".into(),
                name: "A".into(),
                ..Default::default()
            },
            Found {
                kind: "steam".into(),
                launch: "1".into(),
                name: "A".into(),
                ..Default::default()
            },
        ];
        sort_and_dedup(&mut v);
        assert_eq!(v.len(), 1);
    }
}
