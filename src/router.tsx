import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { WikiListPage } from './pages/WikiListPage'
import { WikiDetailPage } from './pages/WikiDetailPage'
import { WikiEditPage } from './pages/WikiEditPage'
import { NotFoundPage } from './pages/NotFoundPage'

/** 前端路由入口 */
export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="register" element={<RegisterPage />} />
          <Route path="wiki" element={<WikiListPage />} />
          <Route path="wiki/:slug" element={<WikiDetailPage />} />
          <Route path="wiki/:slug/edit" element={<WikiEditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
