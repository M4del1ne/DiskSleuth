// disksleuth-server: the DiskSleuth local backend.
//
// On startup it prints one JSON line to stdout: {"event":"ready","url":"http://127.0.0.1:<port>","token":"…"};
// the Electron main process reads that line to get the address and token. Logs go to stderr.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"

	"forensics/internal/server"
)

func main() {
	root := defaultRoot()
	addr := flag.String("addr", "127.0.0.1:0", "listen address (loopback only)")
	token := flag.String("token", "", "access token; random when empty")
	plugins := flag.String("plugins", filepath.Join(root, "plugins"), "Python plugin directory")
	python := flag.String("python", filepath.Join(root, ".venv", "Scripts", "python.exe"), "Python interpreter")
	cases := flag.String("cases", filepath.Join(root, "cases"), "case root directory (one subdirectory with case.db per case)")
	flag.Parse()

	if host, _, err := net.SplitHostPort(*addr); err != nil || (host != "127.0.0.1" && host != "localhost") {
		log.Fatalf("only 127.0.0.1 may be used as listen address, got: %s", *addr)
	}
	if *token == "" {
		b := make([]byte, 24)
		rand.Read(b)
		*token = hex.EncodeToString(b)
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(*cases, 0o755); err != nil {
		log.Fatal(err)
	}
	srv := server.New(server.Config{Token: *token, PluginsDir: *plugins, Python: *python, CasesDir: *cases})
	defer srv.Close()

	ready, _ := json.Marshal(map[string]string{"event": "ready", "url": "http://" + ln.Addr().String(), "token": *token})
	os.Stdout.Write(append(ready, '\n'))
	log.Printf("DiskSleuth backend %s listening on %s (plugins %s, cases %s)", server.Version, ln.Addr(), *plugins, *cases)

	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt)
		<-c
		srv.Close()
		os.Exit(0)
	}()
	log.Fatal(http.Serve(ln, srv))
}

// defaultRoot guesses the project root: the executable lives in <root>/build/bin/.
func defaultRoot() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Clean(filepath.Join(filepath.Dir(exe), "..", ".."))
}
