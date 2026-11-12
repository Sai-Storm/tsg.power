# TSG Power Engineering frontend

React + Vite operations workspace following the frontend architecture in the supplied system design report. It includes a single role-aware application shell, Admin and Staff navigation, dashboards, reusable module tables, protected routes, and shared Excel/PDF and delete controls.

## Run locally

```sh
npm.cmd install
npm.cmd run dev
```

On macOS or Linux, use `npm install` and `npm run dev`.

Use **Continue as Admin** or **Continue as Staff** on the sign-in screen to preview the role-specific interface. These demo accounts use sample in-memory records and do not authenticate against a server.

## API connection

The API client expects the Express REST API at `/api` by default. Set `VITE_API_URL` in a `.env` file when the API uses another origin, for example `VITE_API_URL=http://localhost:3000/api`. Sign-in calls `POST /auth/login`; exports call the corresponding module list endpoint with the active filters and `format=xlsx|pdf`. JWT access tokens are sent as Bearer tokens.

Module screens use report-based sample records in demo mode. With a real account, list queries, filtered exports, create/update/delete actions and supported workflow actions call the REST API. The UI role checks are for navigation and usability; authorization must still be enforced on every API route. Demo Excel export downloads an Excel-readable CSV and demo PDF export opens the browser print dialog.
