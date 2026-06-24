# Android APK Build — From Zero

A complete, reproducible recipe for packaging the `jchat` web app as an Android
APK via Capacitor. Written so you (or future-me) can rebuild it without the
chat history that produced it.

Target: `https://jchat.fly.dev/install/` as a download page; APK hosted on
GitHub Releases; installed on a Huawei (HarmonyOS) phone.

---

## 0. Context — what this is and is not

- **What:** wrap the existing `public/` web frontend in a Capacitor Android
  shell that talks to `https://jchat.fly.dev` over HTTPS. No cleartext.
- **What it is not:** a full rewrite, an offline-first app, or a Play Store
  release build. This doc produces a **debug APK** for sideload testing.
- **Repo constraint (per CLAUDE.md):** the chat app and the Schoology
  dashboard share one container. Don't touch `server/`, `schoology/`, or
  `schoology-mcp/` for Android changes.

---

## 1. Prerequisite state (assumed)

You should have:
- macOS, Apple Silicon (`uname -m` → `arm64`).
- Node 18+ and npm.
- Homebrew.
- The repo at `/Users/Benran/Documents/GitHub/chat` (or any clone).
- A working GitHub remote — for this user: `https://github.com/indiamonda/chat.git`.
- A Fly.io account in good billing standing (deploy blocked otherwise —
  status 403 / "overdue invoices" surfaces here, fix at
  https://fly.io/dashboard/jimmy-wu-chinshow/billing).
- A Huawei / HarmonyOS phone (the menu paths in §8 are specific to that).

---

## 2. Install JDK 21 (no sudo)

Capacitor 7.x requires **JDK 21** (not 17). The scaffold pins
`sourceCompatibility = VERSION_21` and `cordova-android: 14.0.1`. JDK 17 will
fail with `invalid source release: 21`.

`brew install --cask temurin@17` works but needs an interactive `sudo`
password, which a non-interactive shell can't supply. Workaround: pull the
official OpenJDK tarball from `download.java.net` and extract to `~/.jdk`.

```bash
# aarch64 (Apple Silicon)
curl -fL --retry 3 --max-time 900 \
  -o /tmp/jdk21.tar.gz \
  "https://download.java.net/java/GA/jdk21.0.2/f2283984656d49d69e91c558476027ac/13/GPL/openjdk-21.0.2_macos-aarch64_bin.tar.gz"

mkdir -p ~/.jdk
tar -xzf /tmp/jdk21.tar.gz -C ~/.jdk
rm /tmp/jdk21.tar.gz

# x86_64 (Intel Mac) — use:
# https://download.java.net/java/GA/jdk21.0.2/f2283984656d49d69e91c558476027ac/13/GPL/openjdk-21.0.2_macos-x64_bin.tar.gz
```

Verify:

```bash
~/.jdk/jdk-21.0.2.jdk/Contents/Home/bin/java -version
# openjdk version "21.0.2" 2024-01-16
```

### Network gotchas

From this shell, **github.com is unreachable** (60 s connect timeout). The
working mirrors used in this build:

| Resource | Working URL |
|---|---|
| OpenJDK 17 / 21 | `https://download.java.net/java/GA/...` |
| Gradle 8.14.3 | `https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip` |
| Adoptium API | `https://api.adoptium.net/v3/...` (returns 307 → release-assets; slow but works for API queries) |

Dead from this shell: `https://services.gradle.org` (10 s default wrapper
timeout kills it), `https://github.com`, `https://objects.githubusercontent.com`
as a host probe (asset URLs themselves may still work).

---

## 3. Install Android SDK (Homebrew)

```bash
brew install --cask android-commandlinetools
```

That puts `sdkmanager` on PATH at `/opt/homebrew/bin/sdkmanager` and the SDK
root at `/opt/homebrew/share/android-commandlinetools`.

```bash
export JAVA_HOME="$HOME/.jdk/jdk-21.0.2.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

yes | sdkmanager --licenses > /dev/null
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

The Capacitor scaffold (`android/variables.gradle`) sets `compileSdkVersion = 36`,
so the build will auto-install `platforms;android-36` on first run — that's
fine, just takes longer.

### Persist env to `~/.zshrc`

Idempotent block (safe to re-append):

```bash
# >>> Android / Java 21 toolchain (Capacitor 7 requires JDK 21) >>>
export JAVA_HOME="$HOME/.jdk/jdk-21.0.2.jdk/Contents/Home"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/build-tools/34.0.0:$PATH"
# <<< Android / Java 21 toolchain <<<
```

---

## 4. Initialize Capacitor in the repo

```bash
cd /Users/Benran/Documents/GitHub/chat
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "JimmyQrg Chat" "com.jimmyqrg.chat" --web-dir=public
npx cap add android
```

This creates:
- `capacitor.config.json` (app id, name, `webDir: "public"`)
- `android/` directory with full Capacitor scaffold
- `android/app/src/main/AndroidManifest.xml` (no `usesCleartextTraffic` — good,
  we want HTTPS only)

---

## 5. Fix the gradle wrapper

The generated `android/gradle/wrapper/gradle-wrapper.properties` points at
`services.gradle.org` with a 10 s timeout. Both fail from this network.

Edit it to:

```properties
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip
networkTimeout=600000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
```

---

## 6. Sync and build

```bash
cd /Users/Benran/Documents/GitHub/chat
npx cap sync android         # copies public/ into android/app/src/main/assets/public
cd android
./gradlew assembleDebug --no-daemon
```

First run: ~6 min (downloads gradle + AGP 8.13.0 + dependencies).
Subsequent: ~90 s.

Output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

~27 MB, package `com.jimmyqrg.chat`, label "JimmyQrg Chat", minSdk 24,
targetSdk 36, signed with auto-generated debug key.

---

## 7. The `/install/` page

A static HTML page at `public/install/index.html` is served by Express's
`express.static('public')` middleware as `https://jchat.fly.dev/install/`.
**No server-side route needed.**

The page contains:
- A download button linking to the GitHub Release APK URL
- Three info pills: version, size, min Android
- A Huawei-specific warning box (since the toggle path differs from stock
  Android)
- A collapsible step-by-step install guide

Button URL pattern (must match the GitHub Release you create):

```html
<a href="https://github.com/indiamonda/chat/releases/download/v1.0-debug/app-debug.apk">
```

The full page is committed at `public/install/index.html` — read it for the
exact styling.

---

## 8. GitHub Release (where the APK actually lives)

1. Open https://github.com/indiamonda/chat/releases/new
2. Tag: `v1.0-debug` · Title: `JimmyQrg Chat — debug APK`
3. Drag `app-debug.apk` into "Attach binaries"
4. Description: `Debug build. Allow "Install unknown apps" for your browser before installing.`
5. Click **Publish release**

Direct download URL becomes:

```
https://github.com/indiamonda/chat/releases/download/v1.0-debug/app-debug.apk
```

---

## 9. Deploy `jchat` to Fly.io

The `fly.toml` `[build]` block must explicitly name the Dockerfile (modern
`fly` CLI no longer auto-detects):

```toml
[build]
  dockerfile = "Dockerfile"
```

Without this, deploy errors with:
`app does not have a Dockerfile or buildpacks configured`.

```bash
fly auth login              # browser tab → click Authorize
cd /Users/Benran/Documents/GitHub/chat
fly deploy -a jchat
```

Expect 3–8 min. There's 30–60 s of downtime during machine swap (chat +
Schoology both restart since they're in one container).

**If billing is overdue:** Fly's depot builder returns 403 with
`Your account has overdue invoices`. Fix at
https://fly.io/dashboard/jimmy-wu-chinshow/billing. Until that's clear, no
deploy runs — the existing machine keeps serving the old code.

After deploy succeeds, `/install/` goes live. Test by visiting
`https://jchat.fly.dev/install/` on the phone.

---

## 10. Install on a Huawei phone (HarmonyOS)

Stock Android's `Settings → Apps → Special access → Install unknown apps`
**does not exist on HarmonyOS under those names**. The toggle has been moved
and renamed three times across versions. Paths to try, in order:

1. **设置 → 应用和服务 → 应用管理** → tap the browser used (Chrome / Huawei
   Browser) → scroll to bottom → **安装外部来源应用** (toggle on).
2. **设置 → search box** → type `外部来源` → result opens the toggle directly.
3. **设置 → 系统和更新 → 纯净模式** → if on, blocks all sideloading — turn off.
4. **设置 → 隐私 → 权限管理** → scroll all the way down →
   **特殊权限 → 安装外部来源应用**.

**Easiest path on any HarmonyOS version:** download the APK, tap it. The
"blocked by security" dialog has a **设置** / **Settings** button that
jumps straight to the toggle for whichever app opened it.

If those fail, tell me the HarmonyOS version (Settings → About → HarmonyOS
version) and I can pin the exact path.

---

## 11. End-to-end sequence (TL;DR)

```bash
# One-time setup
brew install --cask android-commandlinetools
# Install JDK 21 per §2 (manual download from download.java.net)
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
cd /Users/Benran/Documents/GitHub/chat
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "JimmyQrg Chat" "com.jimmyqrg.chat" --web-dir=public
npx cap add android
# Patch android/gradle/wrapper/gradle-wrapper.properties per §5
# Add [build] dockerfile = "Dockerfile" to fly.toml per §9

# Per build
npx cap sync android
(cd android && ./gradlew assembleDebug)

# Distribute
cp android/app/build/outputs/apk/debug/app-debug.apk ~/Desktop/
# Create GitHub Release, drag-drop APK, tag v1.0-debug
# Visit https://jchat.fly.dev/install/ on phone

# Deploy
fly auth login
fly deploy -a jchat
```

---

## 12. Known issues / quirks

- **Disk full in /private/tmp** during long builds. Symptom: harness can't
  write tool output, every Bash call fails with `ENOSPC`. Fix:
  `rm -rf /private/tmp/claude-502/*` (harness cache, safe to delete).
- **Gradle download via wrapper** fails silently if `distributionUrl` is
  unreachable AND `networkTimeout` is 10 s. Set both to the Tencent mirror
  and 600 s.
- **JDK 17 vs 21** — Capacitor 7 requires JDK 21. JDK 17 gives
  `invalid source release: 21` at `compileDebugJavaWithJavac`. If you ever
  downgrade, the build breaks at this exact task.
- **`compileSdkVersion = 36`** in `android/variables.gradle` is one above
  what `sdkmanager` was explicitly told to install (`android-34`). Gradle
  triggers a `sdkmanager` install of `android-36` mid-build — fine, just
  adds time. Pin to 34 explicitly if you want to skip that step.
- **Cleartext traffic** is intentionally NOT enabled. The app talks to
  `https://jchat.fly.dev`. Don't add `android:usesCleartextTraffic="true"`
  to the manifest unless you switch the target to an HTTP server.
- **Debug signing** is auto-generated by AGP. The same debug key on the
  same machine is used for every build — uninstall the app before
  reinstalling if you change package name, otherwise Android refuses with
  "INSTALL_FAILED_UPDATE_INCOMPATIBLE".
- **The bogus `<application android:usesCleartextTraffic="true" ...>` snippet
  in `index.html` / `public/index.html` is invalid HTML and was removed.**
  If you ever see it again, delete it — Android attributes don't belong in
  HTML `<head>`. The correct place for cleartext config (if ever needed)
  is `android/app/src/main/AndroidManifest.xml`.

---

## 13. Files touched in this work

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | added `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` |
| `capacitor.config.json` | created by `cap init` |
| `android/` | full directory created by `cap add android` |
| `android/gradle/wrapper/gradle-wrapper.properties` | mirror + timeout patch |
| `android/app/src/main/assets/public/` | mirrors `public/` (do not edit by hand) |
| `fly.toml` | added `dockerfile = "Dockerfile"` under `[build]` |
| `public/install/index.html` | new install landing page |
| `~/.zshrc` | added JAVA_HOME / ANDROID_HOME / PATH block |
| `~/.jdk/jdk-17.0.2.jdk/` | downloaded but unused — safe to `rm -rf` (~350 MB) |
| `~/.jdk/jdk-21.0.2.jdk/` | active JDK |

---

## 14. Manual download mirror list (in case one is dead)

```
# JDK 21 aarch64
https://download.java.net/java/GA/jdk21.0.2/f2283984656d49d69e91c558476027ac/13/GPL/openjdk-21.0.2_macos-aarch64_bin.tar.gz

# JDK 21 x64
https://download.java.net/java/GA/jdk21.0.2/f2283984656d49d69e91c558476027ac/13/GPL/openjdk-21.0.2_macos-x64_bin.tar.gz

# JDK 17 aarch64
https://download.java.net/java/GA/jdk17.0.2/dfd4a8d0985749f896bed50d7138ee7f/8/GPL/openjdk-17.0.2_macos-aarch64_bin.tar.gz

# Gradle 8.14.3 (-all.zip)
https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-all.zip
https://mirrors.aliyun.com/macports/distfiles/gradle/gradle-8.14.3-all.zip
https://repo.huaweicloud.com/gradle/gradle-8.14.3-all.zip
```

---

## 15. Decision log — what was tried and rejected

A record of dead ends so they're not retried.

| Tried | Why it failed | What we did instead |
|---|---|---|
| `brew install --cask temurin@17` | Cask is a `.pkg` requiring interactive `sudo`; non-interactive shell can't supply password. | Downloaded OpenJDK tarball from `download.java.net` and extracted to `~/.jdk` (no sudo). |
| `npx cap sync android` with JDK 17 | Build failed at `:capacitor-cordova-android-plugins:compileDebugJavaWithJavac` with `invalid source release: 21`. | Switched to JDK 21.0.2. |
| Curl from `services.gradle.org` | 60 s connect timeout (host unreachable from this network). | Repointed `distributionUrl` to `mirrors.cloud.tencent.com/gradle/`. |
| Curl from `release-assets.githubusercontent.com` via Adoptium API redirect | Speed throttled to ~1 KB/s — 185 MB download projected at 50+ hours. | Used `download.java.net` direct path instead. |
| Setting `android:usesCleartextTraffic="true"` in HTML `<head>` | Invalid HTML; browser ignores it. Real Android attribute belongs in `AndroidManifest.xml`. | Removed from HTML; manifest left default (HTTPS only). |
| Syncing `index.html` with `public/index.html` | They're intentionally different — root is a redirect stub, `public/` is the app. | Left them different. |
| Running `./gradlew assembleDebug` without `JAVA_HOME` exported | `java` on PATH defaults to system Java 8 (`1.8.0_491`); AGP 8.x requires JDK 17+. | Set `JAVA_HOME` explicitly in the env block. |

---

## 16. Pre-flight checklist

Before running the deploy, verify each of these on the working machine:

```bash
# JDK 21 active
~/.jdk/jdk-21.0.2.jdk/Contents/Home/bin/java -version
# expect: openjdk version "21.0.2"

# sdkmanager on PATH
which sdkmanager
# expect: /opt/homebrew/bin/sdkmanager

# platforms installed
ls /opt/homebrew/share/android-commandlinetools/platforms
# expect at least: android-34 android-36

# build-tools installed
ls /opt/homebrew/share/android-commandlinetools/build-tools
# expect at least: 34.0.0

# Fly auth
fly auth whoami
# expect: ikunbeautiful@gmail.com (or your email)

# Fly billing current
fly status -a jchat
# If 403 with "overdue invoices", fix billing first:
#   https://fly.io/dashboard/jimmy-wu-chinshow/billing

# Repo clean and on main
git status
git log --oneline -1
# expect HEAD on a recent Android-related commit
```

---

## 17. Post-deploy verification

After `fly deploy -a jchat` returns success:

```bash
# Confirm the new image rolled out
fly status -a jchat
# expect: Image = jchat:deployment-<new-hash>
#         LAST UPDATED = recent

# Hit the install page
curl -fsSL https://jchat.fly.dev/install/ | head -20
# expect: <!DOCTYPE html>... JimmyQrg Chat... Download & Install APK

# Confirm the chat itself still works (regression check)
curl -fsS -o /dev/null -w '%{http_code}\n' https://jchat.fly.dev/
# expect: 200 or 302

# Confirm Schoology still works (regression check)
curl -fsS -o /dev/null -w '%{http_code}\n' https://jchat.fly.dev/schoology/
# expect: 200
```

Then on the phone:
1. Open `https://jchat.fly.dev/install/` in Huawei Browser (or Chrome).
2. Tap **Download & Install APK**.
3. Tap the downloaded `.apk` in the notification bar.
4. If blocked: tap **设置** in the dialog → toggle **允许此来源** on for the browser.
5. Re-open the APK, confirm install.
6. Open **JimmyQrg Chat** from the launcher; should load `https://jchat.fly.dev`.

---

## 18. Day-to-day build loop

After the initial setup, the iteration loop for changes is short:

```bash
# 1. Edit files under public/ as usual
$EDITOR public/assets/js/main.js

# 2. Re-bundle into Android
cd /Users/Benran/Documents/GitHub/chat
npx cap sync android

# 3. Rebuild APK (~90s warm)
(cd android && ./gradlew assembleDebug)

# 4. Test locally on phone via adb
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# 5. Publish to GitHub Release (drag-drop new APK, keep same tag OR bump)
```

There's no need to re-run `cap init`, `cap add android`, `sdkmanager`, or
re-edit `~/.zshrc` for routine rebuilds.

---

## 19. Release build (future — for Play Store)

This doc produces a debug APK. For a real release:

1. Generate a keystore:
   ```bash
   keytool -genkey -v \
     -keystore ~/keys/jchat-release.jks \
     -keyalg RSA -keysize 2048 -validity 9125 \
     -alias jchat
   ```
   **Treat the .jks like a password.** Lost keystore = can never update the
   Play Store listing under the same identity.

2. Add `signingConfigs.release` to `android/app/build.gradle` referencing
   the keystore (use env vars for passwords, don't commit them).

3. Add `buildTypes.release { signingConfig signingConfigs.release }` to the
   same file.

4. Run `./gradlew assembleRelease` for an APK, or
   `./gradlew bundleRelease` for an AAB (Play Store format since Aug 2021).

5. Upload the AAB to Play Console.

Debug builds can be installed side-by-side with release builds because they
use a different applicationId suffix (`com.jimmyqrg.chat.debug` vs
`com.jimmyqrg.chat`).

---

## 20. Environment recap

Final state of the machine after completing this build:

| Path | What | Size |
|---|---|---|
| `~/.jdk/jdk-21.0.2.jdk/` | Active JDK 21 | ~350 MB |
| `~/.jdk/jdk-17.0.2.jdk/` | Unused JDK 17 — safe to delete | ~350 MB |
| `/opt/homebrew/share/android-commandlinetools/` | Android SDK | ~1.5 GB |
| `/opt/homebrew/Caskroom/android-commandlinetools/` | Brew cask receipt | small |
| `~/.gradle/wrapper/dists/gradle-8.14.3-all/` | Cached gradle distribution | ~700 MB |
| `~/.gradle/caches/` | Maven/AGP cache | ~500 MB after first build |
| `~/Desktop/app-debug.apk` | The built APK | 27 MB |
| `~/keys/jchat-release.jks` | (future) release keystore | ~3 KB |

Total Android-related footprint: ~3.5 GB. Most of it is cache that survives
rebuilds and speeds up the next build by ~10×.

---

## 21. Cross-references

- `CLAUDE.md` — repo-level rules (the "this repo also powers other
  applications" constraint; the schoology hard separation; theme/auth
  gotchas).
- `agent.md` — free-form session notes (existing file, not modified by this
  build).
- `README.md` — repo overview (existing).
- `public/install/index.html` — the actual landing page styling.
- `capacitor.config.json` — `appId`, `appName`, `webDir` source of truth.
- `android/variables.gradle` — `minSdkVersion`, `compileSdkVersion`,
  `targetSdkVersion` source of truth.
- `android/gradle/wrapper/gradle-wrapper.properties` — gradle version +
  mirror source of truth.