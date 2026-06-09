import { render } from "solid-js/web"
import { Router, Route } from "@solidjs/router"
import { AppLayout } from "./app"
import { MainLayout } from "./pages/main-layout"
import { ChatPage } from "./pages/chat"
import "./index.css"

render(
  () => (
    <Router root={AppLayout}>
      <Route path="/" component={MainLayout}>
        <Route path="/" component={ChatPage} />
        <Route path="/chat/new" component={ChatPage} />
        <Route path="/chat/:id" component={ChatPage} />
      </Route>
    </Router>
  ),
  document.getElementById("root")!
)
