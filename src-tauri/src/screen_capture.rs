use std::sync::Arc;
use tauri::{AppHandle, Manager, Window};
use crate::llm::{image_input::ImageInput, provider::CancelToken};

#[derive(Clone, Copy)]
struct ScreenRect { x: i32, y: i32, width: u32, height: u32 }
struct VisibleWindow { window: Window, topmost: bool, focused: bool }

fn can_restore(current_meeting: Option<&str>, expected: &str) -> bool { current_meeting == Some(expected) }
fn needs_hide(privacy: bool, excluded: impl Iterator<Item=bool>) -> bool { !privacy || !excluded.into_iter().all(|value| value) }

async fn on_ui<T: Send + 'static>(app: &AppHandle, action: impl FnOnce(&AppHandle) -> Result<T,String> + Send + 'static) -> Result<T,String> {
    let (tx,rx)=tokio::sync::oneshot::channel(); let handle=app.clone();
    app.run_on_main_thread(move || {let _=tx.send(action(&handle));}).map_err(|_|"Не удалось подготовить окно для снимка")?;
    rx.await.map_err(|_|"Окно было закрыто во время снимка")?
}

fn restore_windows(app: &AppHandle, windows: &[VisibleWindow], meeting_id: &str) -> Result<(),String> {
    // Ctrl+M may finish the recording while the app is temporarily hidden.
    let live=app.state::<crate::state::AppState>();
    if !can_restore(live.live_meeting.lock().map_err(|_|"Не удалось проверить сессию")?.as_ref().map(|m|m.id.as_str()), meeting_id) {return Ok(());}
    let mut failed=false;
    for saved in windows {
        #[cfg(target_os="windows")]
        {
            // A background screenshot must leave the call's foreground window
            // alone. Only restore focus when NexQ owned it before capture.
            use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
            match saved.window.hwnd() {
                Ok(hwnd) => unsafe { let _=ShowWindow(windows::Win32::Foundation::HWND(hwnd.0 as *mut _), SW_SHOWNOACTIVATE); },
                Err(_) => failed=true,
            }
        }
        #[cfg(not(target_os="windows"))]
        { failed |= saved.window.show().is_err(); }
        failed |= saved.window.set_always_on_top(saved.topmost).is_err();
    }
    for saved in windows.iter().filter(|s|s.focused) {let _=saved.window.set_focus();}
    if failed {Err("Не удалось восстановить окно после снимка".into())} else {Ok(())}
}

struct HiddenWindows { app: AppHandle, windows: Option<Vec<VisibleWindow>>, meeting_id: String }
impl HiddenWindows {
    async fn restore(mut self) -> Result<(),String> {
        let windows=self.windows.take().unwrap_or_default(); let meeting_id=self.meeting_id.clone();
        on_ui(&self.app,move |app|restore_windows(app,&windows,&meeting_id)).await
    }
}
impl Drop for HiddenWindows {
    fn drop(&mut self) {
        if let Some(windows)=self.windows.take() {
            let app=self.app.clone(); let meeting=self.meeting_id.clone();
            let _=self.app.run_on_main_thread(move || {let _=restore_windows(&app,&windows,&meeting);});
        }
    }
}

/// Only the chosen monitor is captured; PNG/base64 remain in this request's memory.
pub async fn capture(app: &AppHandle, window_label: String, meeting_id: String, cancel: Arc<CancelToken>) -> Result<ImageInput,String> {
    if !cfg!(target_os="windows") {return Err("Снимок экрана пока поддерживается в Windows".into());}
    let expected=meeting_id.clone(); let preparation_cancel=cancel.clone();
    let (rect,windows)=on_ui(app,move |app| {
        if preparation_cancel.is_cancelled() {return Err("Снимок отменён".into());}
        let state=app.state::<crate::state::AppState>();
        if !state.live_meeting.lock().map_err(|_|"Не удалось проверить сессию")?.as_ref().is_some_and(|m|m.id==expected) {return Err("Сессия уже завершена".into());}
        let owner=app.get_webview_window(&window_label).ok_or("Окно приложения закрыто")?;
        let monitor=owner.current_monitor().map_err(|_|"Не удалось определить экран")?.ok_or("Не удалось определить экран")?;
        let rect=ScreenRect{x:monitor.position().x,y:monitor.position().y,width:monitor.size().width,height:monitor.size().height};
        let mut windows=Vec::new();
        for window in app.webview_windows().into_values() {
            if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
                windows.push(VisibleWindow{topmost:window.is_always_on_top().unwrap_or(false),focused:window.is_focused().unwrap_or(false),window:window.as_ref().window()});
            }
        }
        // Capture-excluded windows are already absent from GDI captures. Keep
        // them visible, with no focus change or hide/show flash.
        if !needs_hide(crate::commands::stealth_commands::stealth_enabled(), windows.iter().map(|w| crate::commands::stealth_commands::capture_is_excluded(&w.window))) {
            windows.clear();
        }
        for saved in &windows {
            // Release the topmost surface first, as in the normal hide path.
            if saved.window.set_always_on_top(false).and_then(|_|saved.window.hide()).is_err() {
                let _=restore_windows(app,&windows,&expected);
                return Err("Не удалось скрыть NexQ перед снимком".into());
            }
        }
        Ok((rect,windows))
    }).await?;
    let hidden=HiddenWindows{app:app.clone(),windows:Some(windows),meeting_id};
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    let pixels=if cancel.is_cancelled() {Err("Снимок отменён".into())} else {
        tokio::task::spawn_blocking(move || capture_pixels(rect)).await.map_err(|_|"Не удалось захватить экран".to_string()).and_then(|v|v)
    };
    // Restore before compression, networking, and every error/cancellation return.
    hidden.restore().await?;
    let (width,height,pixels)=pixels?;
    if cancel.is_cancelled() {return Err("Снимок отменён".into());}
    tokio::task::spawn_blocking(move || encode(width,height,pixels)).await.map_err(|_|"Не удалось подготовить снимок".to_string())?
}

fn encode(width:u32,height:u32,pixels:Vec<u8>)->Result<ImageInput,String> {
    use image::{DynamicImage, ImageFormat, RgbImage};
    let rgb=RgbImage::from_raw(width,height,pixels).ok_or("Некорректные размеры снимка")?;
    let mut image=DynamicImage::ImageRgb8(rgb);
    if width.max(height)>2560 {image=image.resize(2560,2560,image::imageops::FilterType::Triangle);}
    let mut bytes=std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes,ImageFormat::Png).map_err(|_|"Не удалось сжать снимок")?;
    if bytes.get_ref().len()>8*1024*1024 {
        image=image.resize(1920,1920,image::imageops::FilterType::Triangle);
        bytes=std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes,ImageFormat::Png).map_err(|_|"Не удалось сжать снимок")?;
    }
    ImageInput::png(bytes.get_ref(),image.width(),image.height())
}

#[cfg(target_os="windows")]
fn capture_pixels(rect:ScreenRect)->Result<(u32,u32,Vec<u8>),String> {
    use windows::Win32::{Foundation::{HANDLE,HWND},Graphics::Gdi::*};
    if rect.width==0 || rect.height==0 || rect.width>16384 || rect.height>16384 || u64::from(rect.width)*u64::from(rect.height)>40_000_000 {
        return Err("Размер экрана не поддерживается".into());
    }
    struct Resources { screen:HDC, memory:HDC, bitmap:HBITMAP, previous:HGDIOBJ }
    impl Drop for Resources {
        fn drop(&mut self) {unsafe {
            if !self.previous.is_invalid() {let _=SelectObject(self.memory,self.previous);}
            if !self.bitmap.is_invalid() {let _=DeleteObject(self.bitmap);}
            if !self.memory.is_invalid() {let _=DeleteDC(self.memory);}
            if !self.screen.is_invalid() {let _=ReleaseDC(HWND::default(),self.screen);}
        }}
    }
    unsafe {
        let screen=GetDC(HWND::default());
        let mut resources=Resources{screen,memory:HDC::default(),bitmap:HBITMAP::default(),previous:HGDIOBJ::default()};
        if screen.is_invalid() {return Err("Windows не предоставила доступ к экрану".into());}
        resources.memory=CreateCompatibleDC(screen);
        if resources.memory.is_invalid() {return Err("Не удалось подготовить захват экрана".into());}
        let mut info=BITMAPINFO::default();
        info.bmiHeader=BITMAPINFOHEADER{biSize:std::mem::size_of::<BITMAPINFOHEADER>() as u32,biWidth:rect.width as i32,biHeight:-(rect.height as i32),biPlanes:1,biBitCount:32,biCompression:BI_RGB.0,..Default::default()};
        let mut bits=std::ptr::null_mut();
        resources.bitmap=CreateDIBSection(resources.memory,&info,DIB_RGB_COLORS,&mut bits,HANDLE::default(),0).map_err(|_|"Не удалось выделить память для снимка")?;
        resources.previous=SelectObject(resources.memory,resources.bitmap);
        if bits.is_null() || resources.previous.is_invalid() {return Err("Не удалось подготовить изображение экрана".into());}
        BitBlt(resources.memory,0,0,rect.width as i32,rect.height as i32,screen,rect.x,rect.y,SRCCOPY|CAPTUREBLT).map_err(|_|"Windows не разрешила сделать снимок экрана")?;
        let bgra=std::slice::from_raw_parts(bits as *const u8,rect.width as usize*rect.height as usize*4);
        let mut rgb=Vec::with_capacity(rect.width as usize*rect.height as usize*3);
        for pixel in bgra.chunks_exact(4) {rgb.extend_from_slice(&[pixel[2],pixel[1],pixel[0]]);}
        Ok((rect.width,rect.height,rgb))
    }
}

#[cfg(not(target_os="windows"))]
fn capture_pixels(_rect:ScreenRect)->Result<(u32,u32,Vec<u8>),String> {Err("Захват экрана доступен в Windows".into())}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_keeps_only_confirmed_protected_windows_visible() {
        assert!(!needs_hide(true, [true, true].into_iter()));
        assert!(needs_hide(true, [true, false].into_iter()));
        assert!(needs_hide(false, [true, true].into_iter()));
    }
    #[test]
    fn cancelled_capture_cannot_reopen_a_finished_or_replaced_session() {
        assert!(can_restore(Some("live"), "live"));
        assert!(!can_restore(None, "live"));
        assert!(!can_restore(Some("new"), "live"));
    }
    #[test]
    fn screenshot_is_encoded_in_memory_and_large_monitors_are_bounded() {
        let image=encode(3000,10,vec![255;3000*10*3]).unwrap();
        assert!(image.width<=2560); assert!(image.height>0);
        assert!(encode(2,2,vec![0;3]).is_err());
    }
    #[cfg(target_os="windows")]
    #[test]
    #[ignore = "explicit local GDI check; requires an interactive Windows desktop; no pixel data is saved or transmitted"]
    fn windows_capture_returns_pixels_without_saving_or_sending_them() {
        let (width,height,pixels)=capture_pixels(ScreenRect{x:0,y:0,width:64,height:64}).unwrap();
        assert_eq!((width,height,pixels.len()),(64,64,64*64*3));
    }
}
