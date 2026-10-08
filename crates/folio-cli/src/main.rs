fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Err(error) = folio_cli::run(&args) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
