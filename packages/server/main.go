package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── Types ──

type ClaudeSessionInfo struct {
	SessionID    string `json:"sessionId"`
	Title        string `json:"title"`
	ProjectPath  string `json:"projectPath"`
	MessageCount int    `json:"messageCount"`
	LastActivity int64  `json:"lastActivity"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}

type ClaudeHistoryEntry struct{ SessionID string `json:"sessionId"`; Display string `json:"display"` }

type ClaudeHistoryMessage struct {
	ID        string                 `json:"id"`
	Role      string                 `json:"role"`
	Content   string                 `json:"content"`
	Parts     []MessagePart          `json:"parts,omitempty"`
	Timestamp int64                  `json:"timestamp"`
	Extra     map[string]interface{} `json:"extra,omitempty"`
}

type MessagePart struct {
	Type       string                 `json:"type"`
	Text       string                 `json:"text,omitempty"`
	ToolName   string                 `json:"toolName,omitempty"`
	ToolInput  map[string]interface{} `json:"toolInput,omitempty"`
	ToolOutput string                 `json:"toolOutput,omitempty"`
	ToolID     string                 `json:"toolId,omitempty"`
}

// ── Globals ──

var (
	authToken  = getEnv("AUTH_TOKEN", "cchat2web")
	port       = getEnv("PORT", "4096")
	claudePath = getEnv("CLAUDE_PATH", "claude")
	runningCmd = map[string]*exec.Cmd{}
	rcMu       sync.Mutex
	validID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

func getEnv(k, d string) string { if v := os.Getenv(k); v != "" { return v }; return d }

// ── Session Scanning ──

func loadHistoryNames() map[string]string {
	names := make(map[string]string)
	home := os.Getenv("HOME")
	f, err := os.Open(filepath.Join(home, ".claude", "history.jsonl"))
	if err != nil { return names }
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" { continue }
		var e ClaudeHistoryEntry
		if json.Unmarshal([]byte(line), &e) == nil && e.SessionID != "" { names[e.SessionID] = e.Display }
	}
	return names
}

func scanClaudeSessions() []ClaudeSessionInfo {
	home := os.Getenv("HOME")
	projectsDir := filepath.Join(home, ".claude", "projects")
	if _, err := os.Stat(projectsDir); os.IsNotExist(err) { return nil }
	historyNames := loadHistoryNames()
	var sessions []ClaudeSessionInfo
	entries, _ := os.ReadDir(projectsDir)
	for _, entry := range entries {
		if !entry.IsDir() { continue }
		projectDir := filepath.Join(projectsDir, entry.Name())
		files, _ := os.ReadDir(projectDir)
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".jsonl") || strings.HasPrefix(f.Name(), "agent-") { continue }
			sessionID := strings.TrimSuffix(f.Name(), ".jsonl")
			filePath := filepath.Join(projectDir, f.Name())
			info, _ := f.Info()
			projectPath, msgCount, lastTs, inTokens, outTokens := parseSessionMeta(filePath)
			title := historyNames[sessionID]
			if title == "" { title = extractTitle(filePath, sessionID) }
			if title == "" { title = "Untitled Session" }
			lastActivity := info.ModTime().UnixMilli()
			if lastTs > 0 { lastActivity = lastTs }
			sessions = append(sessions, ClaudeSessionInfo{
				SessionID: sessionID, Title: title, ProjectPath: projectPath,
				MessageCount: msgCount, LastActivity: lastActivity,
				InputTokens: inTokens, OutputTokens: outTokens,
			})
		}
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].LastActivity > sessions[j].LastActivity })
	return sessions
}

func parseSessionMeta(filePath string) (projectPath string, msgCount int, lastTimestamp int64, inputTokens int, outputTokens int) {
	f, err := os.Open(filePath)
	if err != nil { return }
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for scanner.Scan() {
		var raw map[string]interface{}
		if json.Unmarshal([]byte(strings.TrimSpace(scanner.Text())), &raw) != nil { continue }
		if tp, _ := raw["type"].(string); tp == "user" || tp == "assistant" { msgCount++ }
		if cwd, ok := raw["cwd"].(string); ok && projectPath == "" { projectPath = cwd }
		if ts, ok := raw["timestamp"].(string); ok {
			if t, err := time.Parse(time.RFC3339, ts); err == nil { lastTimestamp = t.UnixMilli() }
		}
		if tp, _ := raw["type"].(string); tp == "assistant" {
			if msg, ok := raw["message"].(map[string]interface{}); ok {
				if usage, ok := msg["usage"].(map[string]interface{}); ok {
					if v, ok := usage["input_tokens"].(float64); ok { inputTokens = int(v) }
					if v, ok := usage["output_tokens"].(float64); ok { outputTokens = int(v) }
				}
			}
		}
	}
	return
}

func extractTitle(filePath, sessionID string) string {
	f, err := os.Open(filePath)
	if err != nil { return "" }
	defer f.Close()
	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for scanner.Scan() { lines = append(lines, scanner.Text()) }
	for i := len(lines) - 1; i >= 0; i-- {
		var raw map[string]interface{}
		if json.Unmarshal([]byte(strings.TrimSpace(lines[i])), &raw) != nil { continue }
		if raw["sessionId"] != sessionID { continue }
		if tp, _ := raw["type"].(string); tp == "ai-title" {
			if t, ok := raw["aiTitle"].(string); ok && t != "" { return t }
		}
		if tp, _ := raw["type"].(string); tp == "last-prompt" {
			if t, ok := raw["lastPrompt"].(string); ok && t != "" { return t }
		}
	}
	return ""
}

func sanitizeProjectPath(p string) string {
	return regexp.MustCompile(`[^a-zA-Z0-9-]`).ReplaceAllString(p, "-")
}

// ── JSONL Reading ──

type rawJsonlMsg struct {
	Type, SessionID, Timestamp string
	Message                    json.RawMessage
	IsMeta, IsCompactSummary   bool
}

type rawClaudeMsg struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type contentPart struct {
	Type, Text, Name, ID, ToolUseID string
	Input, Content                  json.RawMessage
	Thinking                        string
}

func readJsonlFile(filePath, sessionID string) ([]rawJsonlMsg, error) {
	f, err := os.Open(filePath)
	if err != nil { return nil, err }
	defer f.Close()
	var messages []rawJsonlMsg
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" { continue }
		var entry rawJsonlMsg
		if json.Unmarshal([]byte(line), &entry) != nil { continue }
		if entry.SessionID == sessionID || entry.SessionID == "" { messages = append(messages, entry) }
	}
	return messages, nil
}

func normalizeMessages(raw []rawJsonlMsg, sessionID string) []ClaudeHistoryMessage {
	toolResults := make(map[string]contentPart)
	for _, r := range raw {
		var msg rawClaudeMsg
		if json.Unmarshal(r.Message, &msg) != nil || msg.Role != "user" { continue }
		var content []contentPart
		if json.Unmarshal(msg.Content, &content) == nil {
			for _, part := range content {
				if part.Type == "tool_result" && part.ToolUseID != "" { toolResults[part.ToolUseID] = part }
			}
		}
	}
	var messages []ClaudeHistoryMessage
	for _, r := range raw {
		if r.IsMeta { continue }
		ts := int64(0)
		if r.Timestamp != "" {
			if t, err := time.Parse(time.RFC3339, r.Timestamp); err == nil { ts = t.UnixMilli() }
		}
		if ts == 0 { ts = time.Now().UnixMilli() }
		if r.Type == "thinking" {
			var tmsg struct{ Content string }
			if json.Unmarshal(r.Message, &tmsg) == nil && tmsg.Content != "" {
				messages = append(messages, ClaudeHistoryMessage{
					ID: fmt.Sprintf("%s-t-%d", sessionID, ts), Role: "assistant",
					Content: tmsg.Content, Parts: []MessagePart{{Type: "thinking", Text: tmsg.Content}}, Timestamp: ts,
				})
			}
			continue
		}
		var msg rawClaudeMsg
		if json.Unmarshal(r.Message, &msg) != nil { continue }
		if msg.Role == "assistant" { messages = append(messages, normalizeAssistant(sessionID, ts, msg, toolResults)...) }
		if msg.Role == "user" { messages = append(messages, normalizeUser(sessionID, ts, msg, r)...) }
	}
	return mergeConsecutiveTools(messages)
}

func mergeConsecutiveTools(msgs []ClaudeHistoryMessage) []ClaudeHistoryMessage {
	if len(msgs) == 0 { return msgs }
	result := make([]ClaudeHistoryMessage, 0, len(msgs))
	for i := 0; i < len(msgs); i++ {
		curr := msgs[i]
		if curr.Role != "assistant" || !hasAnyTool(curr.Parts) { result = append(result, curr); continue }
		merged := curr
		j := i + 1
		for j < len(msgs) && msgs[j].Role == "assistant" && !hasTextPart(msgs[j].Parts) {
			for _, p := range msgs[j].Parts {
				if p.Type == "tool_call" || p.Type == "tool_result" { merged.Parts = append(merged.Parts, p) }
			}
			j++
		}
		result = append(result, merged)
		i = j - 1
	}
	return result
}

func hasAnyTool(parts []MessagePart) bool {
	for _, p := range parts { if p.Type == "tool_call" { return true } }
	return false
}

func hasTextPart(parts []MessagePart) bool {
	for _, p := range parts { if p.Type == "text" && p.Text != "" { return true } }
	return false
}

func parseContentString(data json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(data, &s) == nil { return s, true }
	return "", false
}

func isInternal(text string) bool {
	return strings.HasPrefix(text, "<system-reminder>") || strings.HasPrefix(text, "Caveat:") || strings.HasPrefix(text, "[Request interrupted")
}

func normalizeAssistant(sessionID string, ts int64, msg rawClaudeMsg, toolResults map[string]contentPart) []ClaudeHistoryMessage {
	var content []contentPart
	if json.Unmarshal(msg.Content, &content) != nil { return nil }
	var parts []MessagePart
	var textContent string
	for _, part := range content {
		if part.Type == "text" && part.Text != "" {
			textContent += part.Text; parts = append(parts, MessagePart{Type: "text", Text: part.Text})
		} else if part.Type == "tool_use" {
			var input map[string]interface{}
			json.Unmarshal(part.Input, &input)
			parts = append(parts, MessagePart{Type: "tool_call", ToolName: part.Name, ToolID: part.ID, ToolInput: input})
			if tr, ok := toolResults[part.ID]; ok {
				out := ""
				if s, ok2 := parseContentString(tr.Content); ok2 { out = s } else { out = string(tr.Content) }
				if len(out) > 5000 { out = out[:5000] + "\n... [truncated]" }
				parts = append(parts, MessagePart{Type: "tool_result", ToolID: part.ID, ToolOutput: out})
			}
		} else if part.Type == "thinking" && part.Thinking != "" {
			parts = append(parts, MessagePart{Type: "thinking", Text: part.Thinking})
		}
	}
	hasTextOrTool := textContent != ""
	for _, p := range parts { if p.Type == "text" || p.Type == "tool_call" { hasTextOrTool = true; break } }
	if hasTextOrTool {
		return []ClaudeHistoryMessage{{ID: fmt.Sprintf("%s-asst-%d", sessionID, ts), Role: "assistant", Content: strings.TrimSpace(textContent), Parts: parts, Timestamp: ts}}
	}
	return nil
}

func normalizeUser(sessionID string, ts int64, msg rawClaudeMsg, r rawJsonlMsg) []ClaudeHistoryMessage {
	var content []contentPart
	if json.Unmarshal(msg.Content, &content) != nil { return nil }
	var parts []MessagePart
	var textContent string
	hasToolResult := false
	for _, part := range content {
		if part.Type == "text" && part.Text != "" {
			if !isInternal(part.Text) { textContent += part.Text; parts = append(parts, MessagePart{Type: "text", Text: part.Text}) }
		} else if part.Type == "tool_result" { hasToolResult = true }
	}
	if r.IsCompactSummary && textContent != "" {
		return []ClaudeHistoryMessage{{ID: fmt.Sprintf("%s-sum-%d", sessionID, ts), Role: "assistant", Content: textContent, Parts: parts, Timestamp: ts, Extra: map[string]interface{}{"isCompactSummary": true}}}
	}
	if !hasToolResult && textContent != "" {
		return []ClaudeHistoryMessage{{ID: fmt.Sprintf("%s-usr-%d", sessionID, ts), Role: "user", Content: textContent, Parts: parts, Timestamp: ts}}
	}
	return nil
}

func readClaudeSessionMessages(sessionID, projectPath string) ([]ClaudeHistoryMessage, error) {
	home := os.Getenv("HOME")
	if projectPath == "" {
		for _, s := range scanClaudeSessions() { if s.SessionID == sessionID { projectPath = s.ProjectPath; break } }
	}
	if projectPath == "" { return nil, fmt.Errorf("session not found") }
	sessionFile := filepath.Join(home, ".claude", "projects", sanitizeProjectPath(projectPath), sessionID+".jsonl")
	if _, err := os.Stat(sessionFile); os.IsNotExist(err) { return nil, fmt.Errorf("session file not found") }
	raw, err := readJsonlFile(sessionFile, sessionID)
	if err != nil { return nil, err }
	return normalizeMessages(raw, sessionID), nil
}

// ── HTTP Handlers ──

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, event string, data interface{}) {
	d, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(d))
	flusher.Flush()
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	log.Printf("[CHAT] received POST from %s, body size: %d", r.RemoteAddr, r.ContentLength)

	var body struct {
		Text      string `json:"text"`
		SessionID string `json:"sessionId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	text := strings.TrimSpace(body.Text)
	if text == "" { writeJSON(w, 400, map[string]string{"error": "Empty message"}); return }

	flusher, ok := w.(http.Flusher)
	if !ok { writeJSON(w, 500, map[string]string{"error": "Streaming not supported"}); return }

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	args := []string{"--input-format", "stream-json", "--output-format", "stream-json", "-p", "--verbose", "--permission-mode", "bypassPermissions"}
	if body.SessionID != "" && validID.MatchString(body.SessionID) { args = append(args, "--resume", body.SessionID) }

	msgData, _ := json.Marshal(map[string]interface{}{"type": "user", "message": map[string]interface{}{"role": "user", "content": []map[string]interface{}{{"type": "text", "text": text}}}})
	cmd := exec.Command(claudePath, args...)
	cmd.Stdin = strings.NewReader(string(msgData) + "\n")
	cmd.Stderr = os.Stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil { sendSSE(w, flusher, "error", map[string]string{"message": err.Error()}); return }

	abortID := body.SessionID
	if abortID == "" { abortID = "new-" + fmt.Sprintf("%d", time.Now().UnixNano()) }
	rcMu.Lock(); runningCmd[abortID] = cmd; rcMu.Unlock()

	if err := cmd.Start(); err != nil { sendSSE(w, flusher, "error", map[string]string{"message": err.Error()}); return }

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" { continue }
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil { continue }
		msgType, _ := msg["type"].(string)
		subtype, _ := msg["subtype"].(string)
		switch {
		case msgType == "system" && subtype == "init":
			sid, _ := msg["session_id"].(string)
			sendSSE(w, flusher, "init", map[string]interface{}{"sessionId": sid, "model": msg["model"], "permissionMode": msg["permissionMode"]})
		case msgType == "system" && subtype == "thinking_tokens":
			sendSSE(w, flusher, "thinking", map[string]interface{}{"tokens": msg["estimated_tokens"]})
		case msgType == "assistant":
			amsg, _ := msg["message"].(map[string]interface{})
			content, _ := amsg["content"].([]interface{})
			for _, c := range content {
				part, _ := c.(map[string]interface{})
				if part["type"] == "text" { t, _ := part["text"].(string); sendSSE(w, flusher, "text-delta", map[string]string{"text": t}) }
				if part["type"] == "tool_use" {
					sendSSE(w, flusher, "tool-start", map[string]interface{}{"toolId": part["id"], "toolName": part["name"], "toolInput": part["input"]})
				}
			}
		case msgType == "user":
			umsg, _ := msg["message"].(map[string]interface{})
			content, _ := umsg["content"].([]interface{})
			for _, c := range content {
				part, _ := c.(map[string]interface{})
				if part["type"] == "tool_result" {
					output := ""
					if s, ok := part["content"].(string); ok { output = s } else { data, _ := json.Marshal(part["content"]); output = string(data) }
					if len(output) > 5000 { output = output[:5000] + "\n... [truncated]" }
					sendSSE(w, flusher, "tool-end", map[string]interface{}{"toolId": part["tool_use_id"], "output": output})
				}
			}
		case msgType == "result": sendSSE(w, flusher, "done", map[string]string{}); goto done
		}
	}
done:
	cmd.Wait()
	rcMu.Lock(); delete(runningCmd, abortID); rcMu.Unlock()
}

func handleAbort(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	rcMu.Lock()
	if body.SessionID != "" {
		if cmd, ok := runningCmd[body.SessionID]; ok && cmd.Process != nil { cmd.Process.Kill(); delete(runningCmd, body.SessionID) }
	} else {
		for k, cmd := range runningCmd { if strings.HasPrefix(k, "new-") && cmd.Process != nil { cmd.Process.Kill(); delete(runningCmd, k) } }
	}
	rcMu.Unlock()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Router ──

func handleClaudeSessions(w http.ResponseWriter, r *http.Request) {
	sessions := scanClaudeSessions()
	if sessions == nil { sessions = []ClaudeSessionInfo{} }
	writeJSON(w, 200, sessions)
}

func handleClaudeSessionDelete(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/claude-sessions/"), "/delete")
	if !validID.MatchString(sessionID) { writeJSON(w, 400, map[string]string{"error": "Invalid session ID"}); return }
	home := os.Getenv("HOME")
	for _, s := range scanClaudeSessions() {
		if s.SessionID != sessionID { continue }
		sessionFile := filepath.Join(home, ".claude", "projects", sanitizeProjectPath(s.ProjectPath), sessionID+".jsonl")
		if err := os.Remove(sessionFile); err != nil && !os.IsNotExist(err) { writeJSON(w, 500, map[string]string{"error": err.Error()}); return }
		break
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func handleClaudeSessionExport(w http.ResponseWriter, r *http.Request) {
	sessionID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/claude-sessions/"), "/export")
	if !validID.MatchString(sessionID) { writeJSON(w, 400, map[string]string{"error": "Invalid session ID"}); return }
	messages, err := readClaudeSessionMessages(sessionID, "")
	if err != nil { writeJSON(w, 404, map[string]string{"error": err.Error()}); return }
	var md strings.Builder
	md.WriteString("# Claude Session Export\n\n")
	for _, msg := range messages {
		role := "**User**"; if msg.Role == "assistant" { role = "**Claude**" }
		hasThinking, hasTools := false, false
		if msg.Parts != nil { for _, p := range msg.Parts { if p.Type == "thinking" { hasThinking = true }; if p.Type == "tool_call" { hasTools = true } } }
		md.WriteString(fmt.Sprintf("### %s\n\n", role))
		if hasThinking { md.WriteString("> *Thinking...*\n\n") }
		if msg.Content != "" { md.WriteString(msg.Content + "\n\n") }
		if hasTools {
			md.WriteString("**Tools used:**\n")
			for _, p := range msg.Parts {
				if p.Type == "tool_call" { md.WriteString(fmt.Sprintf("- `%s`\n", p.ToolName)) }
				if p.Type == "tool_result" && p.ToolOutput != "" {
					out := p.ToolOutput; if len(out) > 2000 { out = out[:2000] + "\n... *truncated*" }
					md.WriteString(fmt.Sprintf("```\n%s\n```\n", out))
				}
			}
			md.WriteString("\n")
		}
		md.WriteString("---\n\n")
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="claude-%s.md"`, sessionID[:8]))
	w.Write([]byte(md.String()))
}

func handleClaudeSessionMessages(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/claude-sessions/"), "/", 2)
	if len(parts) == 0 || parts[0] == "" { writeJSON(w, 400, map[string]string{"error": "Missing session ID"}); return }
	sessionID := parts[0]
	if !validID.MatchString(sessionID) { writeJSON(w, 400, map[string]string{"error": "Invalid session ID"}); return }
	messages, err := readClaudeSessionMessages(sessionID, "")
	if err != nil { writeJSON(w, 404, map[string]string{"error": err.Error()}); return }
	writeJSON(w, 200, messages)
}

func apiHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
	if r.Method == "OPTIONS" { w.WriteHeader(204); return }

	// No auth — proxy handles access control.
	switch {
	case r.URL.Path == "/api/health": writeJSON(w, 200, map[string]string{"status": "ok"})
	case r.URL.Path == "/api/chat" || r.URL.Path == "/api/send" || strings.Contains(r.URL.Path, "/messages"): handleChat(w, r)
	case r.URL.Path == "/api/abort" && r.Method == "POST": handleAbort(w, r)
	case r.URL.Path == "/api/claude-sessions" || r.URL.Path == "/api/claude-sessions/": handleClaudeSessions(w, r)
	case strings.HasSuffix(r.URL.Path, "/delete") && r.Method == "DELETE": handleClaudeSessionDelete(w, r)
	case strings.HasSuffix(r.URL.Path, "/export"): handleClaudeSessionExport(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/claude-sessions/"): handleClaudeSessionMessages(w, r)
	default: writeJSON(w, 404, map[string]string{"error": "Not found"})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", apiHandler)
	staticDir := filepath.Join(filepath.Dir(os.Args[0]), "..", "app", "dist")
	if _, err := os.Stat(staticDir); os.IsNotExist(err) { staticDir = filepath.Join("..", "app", "dist") }
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") { return }
		// No caching to prevent stale JS/CSS
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		if _, err := os.Stat(filepath.Join(staticDir, r.URL.Path)); os.IsNotExist(err) { http.ServeFile(w, r, filepath.Join(staticDir, "index.html")); return }
		fs.ServeHTTP(w, r)
	})

	addr := "0.0.0.0:" + port
	log.Printf("CChat-Web → http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(addr, mux))
}
