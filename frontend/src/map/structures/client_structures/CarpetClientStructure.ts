import RestrictedZoneClientStructure from "./RestrictedZoneClientStructure";

class CarpetClientStructure extends RestrictedZoneClientStructure {
    public static readonly TYPE = "CarpetClientStructure";
    public carpetType?: number;
    protected activeStyle = {stroke: "rgb(245, 158, 11)", fill: "rgba(245, 158, 11, 0)"};
    protected style = {stroke: "rgb(245, 158, 11)", fill: "rgba(245, 158, 11, 0.35)"};
}

export default CarpetClientStructure;
