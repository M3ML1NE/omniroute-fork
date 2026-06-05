const fs = require('fs');
const file = '/root/omniroute-fork/src/shared/components/layouts/DashboardLayout.tsx';
let content = fs.readFileSync(file, 'utf8');

// It also complained about the nav breadcrumb:
// <nav aria-label="Breadcrumb" style={{ ... }}
// Let's suppress hydration warnings on the Breadcrumbs component too.
