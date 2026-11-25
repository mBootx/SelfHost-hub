use std::collections::HashMap;
use std::path::PathBuf;

fn main() {
    let config = slint_build::CompilerConfiguration::new().with_library_paths(HashMap::from([(
        "hub-ui".to_string(),
        PathBuf::from(hub_ui::UI_DIR),
    )]));
    slint_build::compile_with_config("ui/app.slint", config).expect("Slint UI failed to compile");
}
