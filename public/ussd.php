<?php
declare(strict_types=1);

/**
 * TransitLink USSD Handler using Africa's Talking callbacks
 *
 * Responsibilities:
 * - Parse AT USSD request (sessionId, phoneNumber, text, etc.)
 * - Manage session state in MySQL (level, company, feature, data)
 * - Render modular menus with proper CON/END responses
 * - Provide sample implementations for feature flows
 *
 * Deployment:
 * - Expose this script via a public HTTPS URL
 * - Configure environment variables for DB connection
 *
 * Expected POST params from Africa's Talking:
 * - sessionId, serviceCode, phoneNumber, text, networkCode
 */

// Ensure plain text response for USSD
header('Content-Type: text/plain');

// Read Africa's Talking USSD POST parameters
$sessionId   = $_POST['sessionId']   ?? '';
$serviceCode = $_POST['serviceCode'] ?? '';
$phoneNumber = $_POST['phoneNumber'] ?? '';
$text        = $_POST['text']        ?? '';
$networkCode = $_POST['networkCode'] ?? '';

/**
 * Simple PDO connector using environment variables
 *
 * Required environment variables:
 * - DB_HOST, DB_NAME, DB_USER, DB_PASS
 */
final class Db {
    public static function connect(): PDO {
        $host = getenv('DB_HOST') ?: '127.0.0.1';
        $db   = getenv('DB_NAME') ?: 'transitlink';
        $user = getenv('DB_USER') ?: 'root';
        $pass = getenv('DB_PASS') ?: '';
        $dsn  = "mysql:host={$host};dbname={$db};charset=utf8mb4";

        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        return $pdo;
    }
}

/**
 * Repository for persisting USSD sessions
 *
 * Fields: session_id, phone_number, level, company_id, feature, data(JSON), created_at, updated_at
 */
final class UssdSessionRepository {
    private PDO $pdo;

    public function __construct(PDO $pdo) {
        $this->pdo = $pdo;
    }

    public function get(string $sessionId): ?array {
        $stmt = $this->pdo->prepare('SELECT * FROM ussd_sessions WHERE session_id = ? LIMIT 1');
        $stmt->execute([$sessionId]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function upsert(string $sessionId, string $phoneNumber, int $level, ?int $companyId, ?string $feature, array $data): void {
        $json = json_encode($data, JSON_UNESCAPED_UNICODE);
        $existing = $this->get($sessionId);
        if ($existing) {
            $stmt = $this->pdo->prepare('UPDATE ussd_sessions SET phone_number=?, level=?, company_id=?, feature=?, data=?, updated_at=NOW() WHERE session_id=?');
            $stmt->execute([$phoneNumber, $level, $companyId, $feature, $json, $sessionId]);
        } else {
            $stmt = $this->pdo->prepare('INSERT INTO ussd_sessions(session_id, phone_number, level, company_id, feature, data, created_at, updated_at) VALUES(?,?,?,?,?,?,NOW(),NOW())');
            $stmt->execute([$sessionId, $phoneNumber, $level, $companyId, $feature, $json]);
        }
    }

    public function delete(string $sessionId): void {
        $stmt = $this->pdo->prepare('DELETE FROM ussd_sessions WHERE session_id = ?');
        $stmt->execute([$sessionId]);
    }
}

/**
 * Data access for companies and routes
 */
final class CompaniesRepository {
    private PDO $pdo;
    public function __construct(PDO $pdo) { $this->pdo = $pdo; }

    public function all(): array {
        $stmt = $this->pdo->query('SELECT id, name, contact_number FROM companies ORDER BY id ASC');
        return $stmt->fetchAll();
    }

    public function find(int $id): ?array {
        $stmt = $this->pdo->prepare('SELECT id, name, contact_number FROM companies WHERE id=? LIMIT 1');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
}

final class RoutesRepository {
    private PDO $pdo;
    public function __construct(PDO $pdo) { $this->pdo = $pdo; }

    public function byCompany(int $companyId): array {
        $stmt = $this->pdo->prepare('SELECT id, origin, destination, fare, departure_times FROM routes WHERE company_id=? ORDER BY id ASC');
        $stmt->execute([$companyId]);
        return $stmt->fetchAll();
    }
}

/**
 * Utility: Normalize incoming "text" by handling "0" (Back) navigation
 *
 * Africa's Talking sends cumulative input joined by '*', e.g. "1*2*3".
 * We interpret "0" as Back: remove the previous selection.
 */
function normalizeSelections(string $text): array {
    if ($text === '' || $text === null) {
        return [];
    }
    $parts = array_filter(explode('*', $text), static fn($p) => $p !== '');
    $stack = [];
    foreach ($parts as $p) {
        if ($p === '0') {
            if (!empty($stack)) {
                array_pop($stack);
            }
            // ignore '0' itself
            continue;
        }
        $stack[] = $p;
    }
    return $stack;
}

/**
 * Render: Main menu (Level 0)
 */
function renderMainMenu(array $companies): string {
    $out = "Welcome to TransitLink\n";
    $i = 1;
    foreach ($companies as $c) {
        $out .= "{$i}. " . $c['name'] . "\n";
        $i++;
    }
    return rtrim($out, "\n");
}

/**
 * Render: Company submenu (Level 1)
 */
function renderCompanyMenu(array $company): string {
    $out = $company['name'] . "\n";
    $out .= "1. Check Routes & Fares\n";
    $out .= "2. Book a Bus\n";
    $out .= "3. Report a Case\n";
    $out .= "4. Lost & Found\n";
    $out .= "5. Give Feedback\n";
    $out .= "0. Back to Main Menu";
    return $out;
}

/**
 * Render: Routes & Fares (Level 2 -> END)
 */
function renderRoutesAndFares(array $routes): string {
    if (empty($routes)) {
        return "No routes available at this time.";
    }
    $lines = [];
    foreach ($routes as $r) {
        $lines[] = "{$r['origin']}-{$r['destination']} ({$r['fare']} KES)";
    }
    return implode("\n", $lines);
}

/**
 * Feature: Book a Bus (multi-step)
 *
 * Steps:
 * - Step 1 (Level 2): Show selectable routes
 * - Step 2 (Level 3): Ask for number of seats
 * - Step 3 (Level 4): Confirm booking and END
 */
function handleBooking(array $selections, array $routes, array &$sessionData): array {
    $step = count($selections) - 1; // starting from feature selection
    if ($step === 1) {
        // Show route list for selection
        if (empty($routes)) {
            return ["No routes available to book.", true];
        }
        $out = "Select a route:\n";
        $i = 1;
        foreach ($routes as $r) {
            $out .= "{$i}. {$r['origin']}-{$r['destination']} ({$r['fare']} KES)\n";
            $i++;
        }
        $out .= "0. Back";
        return [rtrim($out, "\n"), false];
    }
    if ($step === 2) {
        // Validate route selection
        $choice = $selections[2] ?? '';
        $idx = intval($choice);
        if ($idx < 1 || $idx > count($routes)) {
            return ["Invalid selection. Enter a valid route number.\n0. Back", false];
        }
        $selected = $routes[$idx - 1];
        $sessionData['booking_route'] = $selected;
        return ["Enter number of seats:\n0. Back", false];
    }
    if ($step === 3) {
        // Capture seats and confirm
        $seatsRaw = $selections[3] ?? '';
        $seats = intval($seatsRaw);
        if ($seats <= 0) {
            return ["Invalid seats. Enter a positive number:\n0. Back", false];
        }
        $sessionData['seats'] = $seats;
        $r = $sessionData['booking_route'];
        $total = $seats * intval($r['fare']);
        $summary = "Booking confirmed:\n"
            . "{$r['origin']} -> {$r['destination']}\n"
            . "Seats: {$seats}\n"
            . "Total: {$total} KES\n"
            . "Thank you for using TransitLink!";
        return [$summary, true];
    }
    return ["Unexpected step. Returning to main menu.", true];
}

/**
 * Feature: Report a Case (two-step)
 */
function handleReportCase(array $selections, array &$sessionData): array {
    $step = count($selections) - 1;
    if ($step === 1) {
        return ["Describe the case:\n0. Back", false];
    }
    if ($step === 2) {
        $sessionData['report'] = $selections[2] ?? '';
        $msg = "Thanks. Your report has been received.\nRef: TL-" . substr(md5((string)rand()), 0, 6);
        return [$msg, true];
    }
    return ["Unexpected step. Ending session.", true];
}

/**
 * Feature: Lost & Found (two-step)
 */
function handleLostFound(array $selections, array &$sessionData): array {
    $step = count($selections) - 1;
    if ($step === 1) {
        return ["Describe the item:\n0. Back", false];
    }
    if ($step === 2) {
        $sessionData['lost_item'] = $selections[2] ?? '';
        $msg = "Thanks. We will contact you if a match is found.";
        return [$msg, true];
    }
    return ["Unexpected step. Ending session.", true];
}

/**
 * Feature: Feedback (three-step)
 */
function handleFeedback(array $selections, array &$sessionData): array {
    $step = count($selections) - 1;
    if ($step === 1) {
        return ["Rate 1-5:\n0. Back", false];
    }
    if ($step === 2) {
        $rating = intval($selections[2] ?? '0');
        if ($rating < 1 || $rating > 5) {
            return ["Invalid rating. Enter 1-5:\n0. Back", false];
        }
        $sessionData['rating'] = $rating;
        return ["Enter feedback comment:\n0. Back", false];
    }
    if ($step === 3) {
        $comment = $selections[3] ?? '';
        $sessionData['comment'] = $comment;
        $msg = "Thanks for your feedback!";
        return [$msg, true];
    }
    return ["Unexpected step. Ending session.", true];
}

/**
 * Controller: Determines current level and renders the appropriate menu/flow
 */
final class UssdController {
    private UssdSessionRepository $sessions;
    private CompaniesRepository $companies;
    private RoutesRepository $routes;

    public function __construct(UssdSessionRepository $sessions, CompaniesRepository $companies, RoutesRepository $routes) {
        $this->sessions  = $sessions;
        $this->companies = $companies;
        $this->routes    = $routes;
    }

    public function handle(string $sessionId, string $phoneNumber, string $text): void {
        $selections = normalizeSelections($text);
        $companies  = $this->companies->all();

        // Determine level by normalized selections
        $level = count($selections);

        // Level 0: Main menu
        if ($level === 0) {
            $this->sessions->upsert($sessionId, $phoneNumber, 0, null, null, []);
            echo "CON " . renderMainMenu($companies);
            return;
        }

        // Level 1: Company selected
        $companyIdx = intval($selections[0]);
        if ($companyIdx < 1 || $companyIdx > count($companies)) {
            $this->sessions->upsert($sessionId, $phoneNumber, 0, null, null, []);
            echo "CON Invalid selection. Try again.\n" . renderMainMenu($companies);
            return;
        }
        $company = $companies[$companyIdx - 1];
        $companyId = intval($company['id']);

        if ($level === 1) {
            $this->sessions->upsert($sessionId, $phoneNumber, 1, $companyId, null, []);
            echo "CON " . renderCompanyMenu($company);
            return;
        }

        // Level 2+: Feature selected
        $featureIdx = intval($selections[1] ?? '0');
        $featureMap = [
            1 => 'routes',
            2 => 'booking',
            3 => 'report',
            4 => 'lost_found',
            5 => 'feedback',
        ];
        $feature = $featureMap[$featureIdx] ?? null;
        if ($feature === null) {
            $this->sessions->upsert($sessionId, $phoneNumber, 1, $companyId, null, []);
            echo "CON Invalid selection. Try again.\n" . renderCompanyMenu($company);
            return;
        }

        $data = [];
        // Routes & Fares: immediate END
        if ($feature === 'routes') {
            $routes = $this->routes->byCompany($companyId);
            $resp   = renderRoutesAndFares($routes);
            $this->sessions->upsert($sessionId, $phoneNumber, 2, $companyId, $feature, $data);
            $this->sessions->delete($sessionId);
            echo "END " . $resp;
            return;
        }

        // Booking: multi-step
        if ($feature === 'booking') {
            $routes = $this->routes->byCompany($companyId);
            [$resp, $end] = handleBooking($selections, $routes, $data);
            $this->sessions->upsert($sessionId, $phoneNumber, $end ? 4 : ($level), $companyId, $feature, $data);
            if ($end) {
                $this->sessions->delete($sessionId);
                echo "END " . $resp;
            } else {
                echo "CON " . $resp;
            }
            return;
        }

        // Report a Case
        if ($feature === 'report') {
            [$resp, $end] = handleReportCase($selections, $data);
            $this->sessions->upsert($sessionId, $phoneNumber, $end ? 3 : ($level), $companyId, $feature, $data);
            if ($end) {
                $this->sessions->delete($sessionId);
                echo "END " . $resp;
            } else {
                echo "CON " . $resp;
            }
            return;
        }

        // Lost & Found
        if ($feature === 'lost_found') {
            [$resp, $end] = handleLostFound($selections, $data);
            $this->sessions->upsert($sessionId, $phoneNumber, $end ? 3 : ($level), $companyId, $feature, $data);
            if ($end) {
                $this->sessions->delete($sessionId);
                echo "END " . $resp;
            } else {
                echo "CON " . $resp;
            }
            return;
        }

        // Feedback
        if ($feature === 'feedback') {
            [$resp, $end] = handleFeedback($selections, $data);
            $this->sessions->upsert($sessionId, $phoneNumber, $end ? 4 : ($level), $companyId, $feature, $data);
            if ($end) {
                $this->sessions->delete($sessionId);
                echo "END " . $resp;
            } else {
                echo "CON " . $resp;
            }
            return;
        }

        // Fallback
        $this->sessions->upsert($sessionId, $phoneNumber, $level, $companyId, $feature, $data);
        echo "END Unexpected selection. Please try again later.";
    }
}

/**
 * Bootstrap: Create controller, handle request
 */
try {
    $pdo = Db::connect();
    $controller = new UssdController(
        new UssdSessionRepository($pdo),
        new CompaniesRepository($pdo),
        new RoutesRepository($pdo)
    );
    $controller->handle($sessionId, $phoneNumber, $text);
} catch (Throwable $e) {
    echo "END Service temporarily unavailable. Please try again later.";
}
