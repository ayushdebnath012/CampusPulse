$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot

function New-RoundedRectanglePath {
    param(
        [System.Drawing.RectangleF]$Rectangle,
        [float]$Radius
    )
    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-CampusPulseIcon {
    param(
        [string]$RelativePath,
        [int]$Size,
        [ValidateSet("square", "round", "full", "foreground")]
        [string]$Mode
    )

    $destination = Join-Path $projectRoot $RelativePath
    $directory = Split-Path -Parent $destination
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null

    $pixelFormat = if ($Mode -eq "full") {
        [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
    } else {
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    }
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, $pixelFormat)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        if ($Mode -ne "foreground") {
            $bounds = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
            $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
                $bounds,
                [System.Drawing.ColorTranslator]::FromHtml("#7774E7"),
                [System.Drawing.ColorTranslator]::FromHtml("#3F3FA9"),
                135
            )
            try {
                if ($Mode -eq "round") {
                    $graphics.FillEllipse($gradient, 0, 0, $Size - 1, $Size - 1)
                } elseif ($Mode -eq "square") {
                    $inset = [Math]::Max(1, [int]($Size * 0.035))
                    $shapeBounds = [System.Drawing.RectangleF]::new(
                        $inset,
                        $inset,
                        [float]($Size - 2 * $inset),
                        [float]($Size - 2 * $inset)
                    )
                    $shape = New-RoundedRectanglePath `
                        -Rectangle $shapeBounds `
                        -Radius ([float]($Size * 0.22))
                    try { $graphics.FillPath($gradient, $shape) } finally { $shape.Dispose() }
                } else {
                    $graphics.FillRectangle($gradient, $bounds)
                }
            } finally {
                $gradient.Dispose()
            }

            $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(34, 255, 255, 255), [float]([Math]::Max(1, $Size * 0.012)))
            try {
                $ringInset = [float]($Size * 0.13)
                $graphics.DrawEllipse($ringPen, $ringInset, $ringInset, $Size - 2 * $ringInset, $Size - 2 * $ringInset)
            } finally {
                $ringPen.Dispose()
            }
        }

        $foregroundScale = if ($Mode -eq "foreground") { 0.46 } else { 0.53 }
        $arcWidth = [float]($Size * $foregroundScale)
        $arcHeight = [float]($Size * ($foregroundScale + 0.08))
        $arcX = [float](($Size - $arcWidth) / 2)
        $arcY = [float](($Size - $arcHeight) / 2)
        $stroke = [float]([Math]::Max(2, $Size * $(if ($Mode -eq "foreground") { 0.085 } else { 0.115 })))
        $cPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $stroke)
        try {
            $cPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $cPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $graphics.DrawArc($cPen, $arcX, $arcY, $arcWidth, $arcHeight, 43, 274)
        } finally {
            $cPen.Dispose()
        }

        $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$densities = @(
    @{ Name = "mdpi"; Legacy = 48; Foreground = 108 },
    @{ Name = "hdpi"; Legacy = 72; Foreground = 162 },
    @{ Name = "xhdpi"; Legacy = 96; Foreground = 216 },
    @{ Name = "xxhdpi"; Legacy = 144; Foreground = 324 },
    @{ Name = "xxxhdpi"; Legacy = 192; Foreground = 432 }
)

foreach ($density in $densities) {
    $folder = "android/app/src/main/res/mipmap-$($density.Name)"
    New-CampusPulseIcon "$folder/ic_launcher.png" $density.Legacy "square"
    New-CampusPulseIcon "$folder/ic_launcher_round.png" $density.Legacy "round"
    New-CampusPulseIcon "$folder/ic_launcher_foreground.png" $density.Foreground "foreground"
}

New-CampusPulseIcon "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png" 1024 "full"
New-CampusPulseIcon "public/icons/icon-512.png" 512 "full"
New-CampusPulseIcon "public/icons/icon-192.png" 192 "full"
New-CampusPulseIcon "public/apple-touch-icon.png" 180 "full"
New-CampusPulseIcon "public/favicon.png" 64 "square"

Write-Output "CampusPulse app icons generated."
